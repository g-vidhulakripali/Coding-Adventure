import { IMPORT_LIMITS } from './limits';

/**
 * Minimal, defensive ZIP reader.
 *
 * Reads the central directory and unpacks one entry at a time from the file on
 * disk (`Blob.slice` + the browser's `DecompressionStream`), so a large archive
 * is never loaded into memory as a whole. Sizes and checksums are verified while
 * unpacking; the declared size is never trusted.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  readonly rawPath: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly packedSize: number;
  readonly problem: string | null;
  /** Unpacks the entry, refusing more than `size` bytes. */
  extract(): Promise<Blob>;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const view = async (blob: Blob, from: number, to: number) => new DataView(await blob.slice(from, to).arrayBuffer());
const big = (v: DataView, at: number) => {
  const n = v.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('The ZIP file contains impossible sizes.');
  return Number(n);
};

export async function readZip(file: Blob): Promise<ZipEntry[]> {
  if (file.size > IMPORT_LIMITS.archiveBytes) throw new ZipError(`The ZIP file is larger than the limit of ${Math.round(IMPORT_LIMITS.archiveBytes / 1024 ** 2)} MB.`);
  const tailFrom = Math.max(0, file.size - 65_557);
  const tail = await view(file, tailFrom, file.size);
  let at = tail.byteLength - 22;
  while (at >= 0 && tail.getUint32(at, true) !== EOCD) at--;
  if (at < 0) throw new ZipError('This is not a ZIP file, or it is damaged.');

  let count = tail.getUint16(at + 10, true);
  let dirSize = tail.getUint32(at + 12, true);
  let dirAt = tail.getUint32(at + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) {
    const loc = at - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== EOCD64_LOCATOR) throw new ZipError('The ZIP file is damaged (ZIP64 record missing).');
    const end = await view(file, big(tail, loc + 8), big(tail, loc + 8) + 56);
    if (end.byteLength < 56 || end.getUint32(0, true) !== EOCD64) throw new ZipError('The ZIP file is damaged (ZIP64 record unreadable).');
    count = big(end, 32);
    dirSize = big(end, 40);
    dirAt = big(end, 48);
  }
  if (count > IMPORT_LIMITS.files * 5) throw new ZipError(`The ZIP file lists ${count.toLocaleString('en')} entries, which is more than this app opens.`);
  if (dirAt + dirSize > file.size) throw new ZipError('The ZIP file is damaged (its list of files is cut off).');

  const dir = await view(file, dirAt, dirAt + dirSize);
  const entries: ZipEntry[] = [];
  const ranges: Array<readonly [number, number]> = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL) throw new ZipError('The ZIP file is damaged (its list of files is unreadable).');
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    const crc = dir.getUint32(p + 16, true);
    let packed = dir.getUint32(p + 20, true);
    let size = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    const mode = dir.getUint32(p + 38, true) >>> 16;
    let localAt = dir.getUint32(p + 42, true);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > dir.byteLength) throw new ZipError('The ZIP file is damaged (its list of files is cut off).');
    const nameBytes = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength);
    const rawPath = new TextDecoder(flags & 0x800 ? 'utf-8' : isUtf8(nameBytes) ? 'utf-8' : 'windows-1252').decode(nameBytes);
    for (let x = p + 46 + nameLength; x + 4 <= p + 46 + nameLength + extraLength; ) {
      const id = dir.getUint16(x, true);
      const length = dir.getUint16(x + 2, true);
      if (id === 1) {
        let f = x + 4;
        const stop = Math.min(f + length, dir.byteLength);
        const next = () => {
          if (f + 8 > stop) throw new ZipError('The ZIP file is damaged (ZIP64 sizes missing).');
          f += 8;
          return big(dir, f - 8);
        };
        if (size === 0xffffffff) size = next();
        if (packed === 0xffffffff) packed = next();
        if (localAt === 0xffffffff) localAt = next();
      }
      x += 4 + length;
    }
    p = end;

    const isDirectory = rawPath.endsWith('/') || rawPath.endsWith('\\');
    const problem =
      flags & 1
        ? 'it is encrypted'
        : (mode & 0xf000) === 0xa000
          ? 'it is a link, not a file'
          : method !== 0 && method !== 8
            ? `its compression method (${method}) is not supported`
            : size > IMPORT_LIMITS.ratioMinBytes && size / Math.max(1, packed) > IMPORT_LIMITS.ratio
              ? 'it unpacks to a suspiciously large size (possible ZIP bomb)'
              : null;
    if (!isDirectory) ranges.push([localAt, localAt + 30 + packed]);
    entries.push({ rawPath, isDirectory, size, packedSize: packed, problem, extract: () => extract(file, { rawPath, method, crc, size, packed, localAt }) });
  }
  // Overlapping entries are how "better" ZIP bombs reuse the same data many times.
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) throw new ZipError('The ZIP file reuses the same data for several files (possible ZIP bomb), so it was not opened.');
  return entries;
}

async function extract(file: Blob, e: { rawPath: string; method: number; crc: number; size: number; packed: number; localAt: number }): Promise<Blob> {
  const header = await view(file, e.localAt, e.localAt + 30);
  if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) throw new ZipError('its data is damaged');
  const from = e.localAt + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const packed = file.slice(from, from + e.packed);
  if (packed.size !== e.packed) throw new ZipError('its data is cut off');
  const stream = e.method === 8 ? (packed.stream() as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(new DecompressionStream('deflate-raw')) : packed.stream();
  const reader = (stream as ReadableStream<Uint8Array<ArrayBuffer>>).getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  let crc = 0xffffffff;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > e.size) throw new ZipError('it unpacks to more data than it declares (possible ZIP bomb)');
      crc = updateCrc(crc, value);
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err instanceof ZipError ? err : new ZipError('its data is damaged');
  }
  if (total !== e.size || (crc ^ 0xffffffff) >>> 0 !== e.crc) throw new ZipError('its data is damaged (checksum differs)');
  return new Blob(chunks);
}

let crcTable: Uint32Array | null = null;
function updateCrc(crc: number, bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return crc >>> 0;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function crc32(bytes: Uint8Array): number {
  return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
