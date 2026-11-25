// The app has no Node types on purpose; these two are only used to build test archives.
// @ts-ignore
import { Blob as NodeBlob, Buffer } from 'node:buffer';
// @ts-ignore
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeText, planImport, readPlanned } from './importProject';
import { checkPath, leftOutFolderOf } from './limits';
import { readZip, ZipError } from './zip';
import type { Candidate, ImportSource } from './sources';

interface Spec {
  name: string;
  data: string;
  /** Lies for hostile archives. */
  size?: number;
  crc?: number;
  flags?: number;
  mode?: number;
  store?: boolean;
  localAt?: number;
}

function zip(specs: Spec[]): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  for (const s of specs) {
    const raw = Buffer.from(s.data);
    const packed = s.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(s.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((s.flags ?? 0) | 0x800, 8);
    head.writeUInt16LE(s.store ? 0 : 8, 10);
    head.writeUInt32LE(s.crc ?? crc32(raw), 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(s.size ?? raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(((s.mode ?? 0) << 16) >>> 0, 38);
    head.writeUInt32LE(s.localAt ?? at, 42);
    parts.push(local, name, packed);
    central.push(head, name);
    at += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return new NodeBlob([...parts, dir, end]) as unknown as Blob;
}

const text = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString('utf8');

describe('readZip', () => {
  it('reads stored and compressed entries with their original paths', async () => {
    const entries = await readZip(zip([{ name: 'src/app.py', data: 'x = 1\n'.repeat(100) }, { name: 'src/größe.txt', data: 'ü', store: true }, { name: 'src/', data: '' }]));
    expect(entries.map((e) => [e.rawPath, e.isDirectory])).toEqual([['src/app.py', false], ['src/größe.txt', false], ['src/', true]]);
    expect(await text(await entries[0]!.extract())).toBe('x = 1\n'.repeat(100));
    expect(await text(await entries[1]!.extract())).toBe('ü');
  });

  it('refuses files that are not ZIPs or are cut off', async () => {
    await expect(readZip(new NodeBlob(['hello']) as unknown as Blob)).rejects.toThrow(ZipError);
    const good = zip([{ name: 'a.py', data: 'x' }]);
    await expect(readZip(good.slice(10))).rejects.toThrow(ZipError);
  });

  it('stops unpacking when an entry is larger than it declares', async () => {
    const [entry] = await readZip(zip([{ name: 'bomb.py', data: 'a'.repeat(100_000), size: 10 }]));
    await expect(entry!.extract()).rejects.toThrow(/more data than it declares/);
  });

  it('flags bombs, encrypted entries and links, and checks checksums', async () => {
    const entries = await readZip(zip([{ name: 'big', data: 'a', size: 50 * 1024 ** 2 }, { name: 'secret', data: 'a', flags: 1 }, { name: 'link', data: '/etc/passwd', mode: 0xa1ff }, { name: 'bad', data: 'abc', crc: 1 }]));
    expect(entries.map((e) => e.problem)).toEqual([expect.stringContaining('bomb'), 'it is encrypted', 'it is a link, not a file', null]);
    await expect(entries[3]!.extract()).rejects.toThrow(/checksum/);
  });

  it('refuses archives whose entries share the same data', async () => {
    await expect(readZip(zip([{ name: 'a', data: 'hello' }, { name: 'b', data: 'hello', localAt: 0 }]))).rejects.toThrow(/reuses the same data/);
  });
});

describe('checkPath', () => {
  it.each(['../evil.py', 'a/../../b', '/etc/passwd', 'C:\\x.py', 'a//b', './a', 'a\u0000b', 'a/\u202egpj.py', ''])('refuses %j', (p) => {
    expect(checkPath(p).ok).toBe(false);
  });
  it('keeps normal paths unchanged', () => {
    expect(checkPath('src/parts/one/a b.py')).toEqual({ ok: true, path: 'src/parts/one/a b.py' });
    expect(checkPath('src\\app.py')).toEqual({ ok: true, path: 'src/app.py' });
  });
  it('recognises tool folders but not files with similar names', () => {
    expect(leftOutFolderOf('p/.venv_two/lib/x.py')).toBe('p/.venv_two');
    expect(leftOutFolderOf('p/src/__pycache__/a.pyc')).toBe('p/src/__pycache__');
    expect(leftOutFolderOf('p/venv.py')).toBeNull();
  });
});

describe('planImport', () => {
  const candidate = (rawPath: string, size = 10): Candidate => ({ rawPath, size, read: () => Promise.resolve(new NodeBlob(['x']) as unknown as Blob) });
  const source = (candidates: Candidate[]): ImportSource => ({ name: 'p', candidates, unopened: ['p/.git'] });

  it('accounts for every offered file: kept, left out, or refused with a reason', () => {
    const plan = planImport(source([candidate('p/a.py'), candidate('p/data.bin'), candidate('p/node_modules/x/y.js'), candidate('p/../../z.py'), candidate('p/a.py'), candidate('p/inner.zip')]));
    expect(plan.files.map((f) => f.file.path)).toEqual(['p/a.py', 'p/data.bin', 'p/inner.zip']);
    expect(plan.files[2]!.file.note).toContain('not opened');
    expect(plan.leftOut.folders).toEqual([{ path: 'p/.git', files: 0, bytes: 0 }, { path: 'p/node_modules', files: 1, bytes: 10 }]);
    expect(plan.leftOut.refused.map((r) => r.reason)).toEqual([expect.stringContaining('..'), 'the same path appears twice']);
  });

  it('lists files that are too large without storing them', async () => {
    const plan = planImport(source([candidate('p/huge.csv', 500 * 1024 ** 2)]));
    expect(plan.files[0]).toMatchObject({ candidate: null, file: { path: 'p/huge.csv', note: expect.stringContaining('Not stored') } });
  });

  it('keeps going when one file cannot be read', async () => {
    const broken: Candidate = { rawPath: 'p/b.py', size: 1, read: () => Promise.reject(new Error('its data is damaged')) };
    const refused: Array<{ path: string; reason: string }> = [];
    const got = [];
    for await (const f of readPlanned(planImport(source([broken, candidate('p/c.py')])), refused)) got.push([f.file.path, f.blob !== null]);
    expect(got).toEqual([['p/b.py', false], ['p/c.py', true]]);
    expect(refused).toEqual([{ path: 'p/b.py', reason: 'its data is damaged' }]);
  });
});

describe('decodeText', () => {
  const blob = (b: Uint8Array | string) => new NodeBlob([b]) as unknown as Blob;
  it('refuses binary content whatever the name says', async () => {
    await expect(decodeText(blob(Buffer.from([1, 0, 2])))).rejects.toThrow(/binary/);
  });
  it('reads UTF-8 and falls back for older encodings', async () => {
    expect(await decodeText(blob('größe'))).toBe('größe');
    expect(await decodeText(blob(Buffer.from([0x67, 0x72, 0xf6])))).toBe('grö');
  });
});
