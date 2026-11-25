import { expect, test } from '@playwright/test';
import { importZip, makeZip, openFile, openProject, PROJECT, ready } from './helpers';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('the sample project runs step by step, and inputs can be changed', async ({ page }) => {
  await page.goto('#/');
  await page.getByRole('button', { name: /open sample/ }).click();
  await ready(page);
  // Three sections: source, laboratory, explanation.
  for (const name of ['Source', 'Visual Lab', 'Explain']) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  const scrub = page.getByRole('slider', { name: 'Step' });
  await expect(page.locator('.lab__status')).toContainText('ran to the end');
  await scrub.fill((await scrub.getAttribute('max'))!);
  await expect(page.locator('.stage2d__console')).toContainText('22.5');
  await page.locator('.lab__dock-tabs [role=tab]', { hasText: 'inputs' }).click();
  const prices = page.locator('.input-field', { hasText: 'prices' }).locator('input');
  await prices.fill('[10, 20, 30, 40]');
  await prices.press('Enter');
  await scrub.fill((await scrub.getAttribute('max'))!);
  await expect(page.locator('.stage2d__console')).toContainText('90.0');
});

test('every file of an imported project is listed, and every kind has a view', async ({ page }) => {
  await openProject(page);
  await expect(page.locator('.file-explorer__summary')).toHaveText(`${Object.keys(PROJECT).length - 1} files`);
  await expect(page.locator('.left-out')).toContainText('1 left out');

  await openFile(page, 'shop/assets/logo.png');
  await expect(page.locator('.preview__facts')).toContainText('PNG · 2 × 1 px');
  await openFile(page, 'shop/assets/fake.png');
  await expect(page.locator('.preview__message')).toContainText('not shown as an image');
  await openFile(page, 'shop/data/rows.csv');
  await expect(page.locator('.preview__facts')).toContainText('2 rows · 2 columns');
  await openFile(page, 'shop/config.json');
  await expect(page.locator('.preview--tree')).toContainText('demo');
  await openFile(page, 'shop/settings.yaml');
  await expect(page.locator('.preview--tree')).toContainText('one');
  await openFile(page, 'shop/README.md');
  await expect(page.locator('.preview--markdown h3')).toHaveText('Tiny shop');
  await openFile(page, 'shop/blob.bin');
  await expect(page.locator('.panel-message')).toContainText('No viewer for this file type');
  await openFile(page, 'shop/inner.zip');
  await expect(page.locator('.panel-message')).toContainText('not opened');
});

test('a notebook is shown as cells and can be walked through without being run', async ({ page }) => {
  await openProject(page);
  await openFile(page, 'shop/nb.ipynb');
  await expect(page.locator('.cm-content')).toContainText('# %% cell 2 (code)');
  await expect(page.locator('.notebook-cells option')).toHaveCount(3);
  const select = page.getByLabel('What to simulate');
  await select.selectOption({ label: 'Run nb.ipynb as a script' });
  const scrub = page.getByRole('slider', { name: 'Step' });
  await scrub.fill((await scrub.getAttribute('max'))!);
  await expect(page.locator('.stage2d__console')).toContainText('8');
});

test('a call leads to its definition in another file, and shows where that is used', async ({ page }) => {
  await openProject(page);
  await openFile(page, 'shop/main.py');
  const link = page.locator('.cm-cp-link', { hasText: /^total$/ });
  await expect(link).toBeVisible();
  await link.click({ modifiers: ['ControlOrMeta'] });
  await expect(page).toHaveURL(/prices\.py&line=6/);
  await expect(page.locator('.explain')).toContainText('total is used 1×');
  await page.locator('.explain__link', { hasText: 'shop/main.py:6' }).click();
  await expect(page).toHaveURL(/main\.py&line=6/);
});

test('libraries, assets and preparation status are shown with their certainty', async ({ page }) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'libraries' }).click();
  const numpy = page.locator('.library', { hasText: 'numpy' });
  await expect(numpy).toContainText('==1.26.4');
  await numpy.locator('summary').click();
  await expect(numpy.getByRole('link')).toHaveAttribute('href', 'https://numpy.org/doc/1.26/');
  await expect(page.locator('.library', { hasText: 'scikit-learn' })).toContainText('any version');
  await page.getByRole('tab', { name: 'assets' }).click();
  await expect(page.locator('.project-panel li', { hasText: 'shop/assets/logo.png' })).toContainText('certain');
  await expect(page.locator('.project-panel li', { hasText: 'shop/data/rows.csv' })).toContainText('shop/prices.py:15');
  await page.getByRole('tab', { name: /^status/ }).click();
  await expect(page.locator('.status-box')).toContainText('all files prepared');
  await expect(page.locator('.project-panel')).toContainText('Second parser agrees in 4 of 4 files');
});

test('a model can be watched inside, with fake values, without leaving the three sections', async ({ page }) => {
  await openProject(page);
  await openFile(page, 'shop/model.py');
  await page.getByLabel('What to simulate').selectOption({ label: 'Call train(x, y)' });
  await page.getByRole('button', { name: /straight line/ }).click();
  const demo = page.locator('.model-demo');
  await expect(demo).toContainText('fake values');
  await demo.getByLabel('Demo step').fill((await demo.getByLabel('Demo step').getAttribute('max'))!);
  await expect(demo).toContainText('best line');
  await expect(demo.locator('.model-demo__try')).toBeVisible();
  for (const name of ['Source', 'Visual Lab', 'Explain']) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await demo.getByRole('button', { name: 'Close the model demo' }).click();
  await expect(page.locator('.lines2d__frame')).toBeVisible();
});

test('values that are not known stay ? and do not stop the walk', async ({ page }) => {
  await openProject(page);
  await openFile(page, 'shop/model.py');
  await page.getByLabel('What to simulate').selectOption({ label: 'Call train(x, y)' });
  await expect(page.locator('.lab__status')).toContainText('some ?');
});

test('works in a narrow window and with the light theme', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await importZip(page, makeZip(PROJECT));
  await expect(page.locator('.compact-tabs')).toBeVisible();
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await expect(page.locator('.lab__scenario')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
