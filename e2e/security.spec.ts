import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { importZip, makeZip, openFile, openProject } from './helpers';

test('hostile content is never run, and nothing leaves the browser', async ({ page }) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4321/') && !/^(blob|data):/.test(r.url())) outside.push(r.url());
  });
  await openProject(page);
  for (const p of ['shop/assets/draw.svg', 'shop/page.html', 'shop/README.md', 'shop/<img src=x onerror=pwned=1>.txt']) {
    await openFile(page, p);
    await page.waitForTimeout(400);
  }
  await openFile(page, 'shop/assets/draw.svg');
  await expect(page.locator('.preview--image img')).toBeVisible();
  for (const tab of ['libraries', 'assets']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(300);
  }
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  expect(outside).toEqual([]);
});

test('the built page only allows its own code and no connections elsewhere', async ({ page }) => {
  await page.goto('#/');
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  const blocked = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
});

const cases: Array<[string, () => Buffer, RegExp]> = [
  ['a file that is not a ZIP', () => Buffer.from('hello'), /not a ZIP file/],
  ['a ZIP that is cut off', () => makeZip({ 'a.py': 'x = 1' }).subarray(0, 40), /not a ZIP file|damaged/],
  ['a ZIP with a broken list of files', () => {
    const z = makeZip({ 'a.py': 'x = 1\n'.repeat(50) });
    z.writeUInt32LE(0x11111111, z.length - 22 - 46 - 4);
    return z;
  }, /damaged/],
  ['only paths that climb out', () => makeZip({ '../../evil.py': 'x = 1' }), /climbs out/],
  ['an empty ZIP', () => makeZip({}), /no files/],
];
for (const [name, build, message] of cases) {
  test(`refuses ${name}`, async ({ page }) => {
    await importZip(page, build());
    await expect(page.locator('.import-card__error')).toContainText(message);
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
  });
}

test('keeps the good files of a ZIP with bad ones, and says what was refused', async ({ page }) => {
  await importZip(page, makeZip({ 'p/main.py': 'x = 1\n', 'p/../../evil.py': 'bad', '/etc/passwd': 'bad', 'C:/x.py': 'bad' }), 'p.zip');
  await expect(page).toHaveURL(/#\/project\//);
  await page.locator('.left-out summary').click();
  await expect(page.locator('.left-out li')).toHaveCount(3);
});

test('stops a ZIP bomb that unpacks to more than it declares', async ({ page }) => {
  await importZip(page, makeZip({ 'p/bomb.txt': Buffer.alloc(20_000_000, 65) }, { size: 1000 }), 'p.zip');
  await expect(page).toHaveURL(/#\/project\//);
  await page.locator('.left-out summary').click();
  await expect(page.locator('.left-out')).toContainText('possible ZIP bomb');
});

test('refuses a tampered backup, and an unsafe path inside one', async ({ page }) => {
  await importZip(page, makeZip({ 'code-playground.json': '{"app":"code-playground","format":99,"projects":[]}' }));
  await expect(page.locator('.import-card__error')).toContainText('different version');
  const manifest = JSON.stringify({ app: 'code-playground', format: 1, projects: [{ dir: 'project-1', name: 'p', savedAt: 1, files: [{ path: '../../evil.py', size: 1 }, { path: 'ok.py', size: 6 }], leftOut: { folders: [], refused: [] } }] });
  await importZip(page, makeZip({ 'project-1/files/ok.py': 'x = 1\n', 'project-1/files/../../evil.py': 'bad', 'code-playground.json': manifest, 'project-1/prepared.json': '[{"version":1,"path":"ok.py"}]' }));
  await expect(page).toHaveURL(/#\/project\//);
  await expect(page.locator('.file-explorer__summary')).toHaveText('1 file');
});

test('a file that looks like Python but is a program is not analysed, and the rest is', async ({ page }) => {
  await importZip(page, makeZip({ 'p/main.py': 'x = 1\nprint(x)\n', 'p/evil.py': Buffer.concat([Buffer.from('MZ\0\0'), randomBytes(500)]) }), 'p.zip');
  await expect(page).toHaveURL(/#\/project\//);
  await expect(page.getByRole('tab', { name: /status ✗1/ })).toBeVisible();
  await openFile(page, 'p/evil.py');
  await expect(page.locator('.panel-message--error')).toContainText('binary data');
});
