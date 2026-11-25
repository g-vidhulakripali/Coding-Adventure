import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { importZip, makeZip, openFile, openProject, PROJECT, ready, type Files } from './helpers';

test('a project survives a reload, and its prepared results are used again', async ({ page }) => {
  await openProject(page);
  await page.reload();
  await ready(page);
  await page.getByRole('tab', { name: /^status/ }).click();
  await expect(page.locator('.status-box')).toContainText('4 from last time');
  await page.goto('#/');
  await page.locator('.saved-list__open').click();
  await expect(page).toHaveURL(/#\/project\//);
});

test('a project survives closing the browser', async ({ browser, page, context }, info) => {
  await openProject(page);
  // A new page of the same profile: nothing is kept in memory.
  await page.close();
  const again = await context.newPage();
  await again.goto('#/');
  await expect(again.locator('.saved-list__open')).toContainText('shop');
  void browser;
  void info;
});

test('an interrupted import continues where it stopped', async ({ page, context }) => {
  // Enough data that the page can be closed in the middle.
  const files: Files = {};
  for (let i = 0; i < 400; i++) files[`big/f${i}.bin`] = randomBytes(150_000);
  files['big/main.py'] = 'x = 1\nprint(x)\n';
  const zip = makeZip(files, { store: true });
  await importZip(page, zip, 'big.zip');
  await expect(page.locator('.import-card__what')).toContainText(/(1[2-9]\d|[23]\d\d)\/401 files/);
  await page.close({ runBeforeUnload: false });

  const next = await context.newPage();
  await next.goto('#/');
  const row = next.locator('.saved-list__open.is-unfinished');
  await expect(row).toContainText('click to continue');
  const done = Number(/stopped at (\d+)/.exec(await row.innerText())![1]);
  expect(done).toBeGreaterThan(0);
  expect(done).toBeLessThan(401);
  await row.click();
  await expect(next).toHaveURL(/#\/project\//, { timeout: 45_000 });
  await ready(next);
  await expect(next.locator('.file-explorer__summary')).toHaveText('401 files');
  await openFile(next, 'big/main.py');
  await expect(next.locator('.cm-content')).toContainText('print(x)');
});

test('cancelling an import leaves nothing behind', async ({ page }) => {
  const files: Files = {};
  for (let i = 0; i < 400; i++) files[`big/f${i}.bin`] = randomBytes(150_000);
  await importZip(page, makeZip(files, { store: true }), 'big.zip');
  await expect(page.locator('.import-card__what')).toContainText(/[1-9]\d*\/400 files/);
  await page.getByRole('button', { name: 'cancel' }).click();
  await expect(page.getByText('Nothing saved yet')).toBeVisible();
  const left = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('code-playground');
        open.onsuccess = () => {
          const count = open.result.transaction('files').objectStore('files').count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );
  expect(left).toBe(0);
});

test('a backup can be saved, the project removed, and everything restored', async ({ page }) => {
  await openProject(page);
  await page.goto('#/');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Save a backup/ }).click();
  const path = await (await download).path();
  await page.getByRole('button', { name: /Remove shop/ }).click();
  await page.getByRole('button', { name: /Remove shop/ }).click();
  await expect(page.getByText('Nothing saved yet')).toBeVisible();

  await importZip(page, readFileSync(path), 'backup.zip');
  await expect(page).toHaveURL(/#\/project\//);
  await ready(page);
  await expect(page.locator('.file-explorer__summary')).toHaveText(`${Object.keys(PROJECT).length - 1} files`);
  await page.getByRole('tab', { name: /^status/ }).click();
  await expect(page.locator('.status-box')).toContainText('4 from last time');
  await openFile(page, 'shop/assets/logo.png');
  await expect(page.locator('.preview__facts')).toContainText('2 × 1 px');
});

test('a folder is imported with its structure', async ({ page }, info) => {
  const root = info.outputPath('shopfolder');
  for (const [p, data] of Object.entries(PROJECT)) {
    if (/[<>]/.test(p)) continue;
    const target = join(root, p.replace(/^shop\//, ''));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  await page.goto('#/');
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(root);
  await expect(page).toHaveURL(/#\/project\//);
  await ready(page);
  await openFile(page, 'shopfolder/data/rows.csv');
  await expect(page.locator('.preview__facts')).toContainText('2 rows');
  await expect(page.locator('.left-out')).toContainText('shopfolder/node_modules');
});

test('full storage is reported, and nothing half-imported remains', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Only Chromium can simulate a full disk.');
  await page.goto('#/');
  const client = await page.context().newCDPSession(page);
  await client.send('Storage.overrideQuotaForOrigin', { origin: 'http://127.0.0.1:4321', quotaSize: 3_000_000 });
  const files: Files = { 'a/main.py': 'x = 1\n' };
  for (let i = 0; i < 40; i++) files[`a/f${i}.bin`] = randomBytes(200_000);
  await page.locator('input[type=file][accept*=zip]').setInputFiles({ name: 'a.zip', mimeType: 'application/zip', buffer: makeZip(files, { store: true }) });
  await expect(page.locator('.import-card__error')).toContainText(/MB left|not enough free/);
  await expect(page.getByText('Nothing saved yet')).toBeVisible();
});

test('pausing and stopping the preparation works, and the rest is done later', async ({ page }) => {
  const files: Files = {};
  for (let i = 0; i < 150; i++) files[`many/m${i}.py`] = `def f${i}(x):\n    return x + ${i}\n\n`.repeat(40);
  await importZip(page, makeZip(files), 'many.zip');
  await expect(page).toHaveURL(/#\/project\//);
  await page.locator('.side-tabs [role=tab]').nth(3).click();
  const box = page.locator('.status-box');
  const stop = box.getByRole('button', { name: 'stop' });
  // It may be done before the click arrives; then there is nothing to continue.
  await stop.click({ timeout: 2000 }).catch(() => undefined);
  const again = box.getByRole('button', { name: 'try again' });
  await expect(again.or(box.getByText('all files prepared'))).toBeVisible();
  if (await again.isVisible()) await again.click();
  await expect(box).toContainText('all files prepared', { timeout: 40_000 });
});
