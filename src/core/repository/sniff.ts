import type { FileCategory } from './types';

/** What a file really holds, judged by its first bytes, whatever its name says. */
export type Content = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'avif' | 'pdf' | 'zip' | 'gzip' | 'program' | 'text' | 'binary' | 'empty';

const IMAGES: ReadonlySet<Content> = new Set(['png', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
export const MIME: Partial<Record<Content, string>> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export function sniff(b: Uint8Array): Content {
  if (b.length === 0) return 'empty';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 0, 2) === 'BM' && b.length > 26 && b[14] === 40) return 'bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if (ascii(b, 4, 8) === 'ftyp' && /avi[fs]/.test(ascii(b, 8, 12))) return 'avif';
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (ascii(b, 0, 2) === 'PK' && (b[2] === 3 || b[2] === 5)) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (ascii(b, 0, 2) === 'MZ' || ascii(b, 1, 4) === 'ELF') return 'program';
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return 'text';
  return b.subarray(0, 8192).includes(0) ? 'binary' : 'text';
}

export function isImage(c: Content): boolean {
  return IMAGES.has(c);
}

/** A sentence when the name and the content do not belong together, else null. */
export function mismatch(category: FileCategory, content: Content): string | null {
  if (content === 'empty') return null;
  if (category === 'image') return isImage(content) ? null : `The name says image, but the content is ${describe(content)}. It is not shown as an image.`;
  if (category === 'other') return null;
  return content === 'text' ? null : `The name says text, but the content is ${describe(content)}.`;
}

function describe(c: Content): string {
  return c === 'program' ? 'a program' : c === 'binary' ? 'binary data' : c === 'text' ? 'text' : c.toUpperCase();
}

/** Width and height from the header, without decoding the image. Null when not known. */
export function imageSize(b: Uint8Array, c: Content): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    switch (c) {
      case 'png':
        return { width: v.getUint32(16), height: v.getUint32(20) };
      case 'gif':
        return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
      case 'bmp':
        return { width: v.getInt32(18, true), height: Math.abs(v.getInt32(22, true)) };
      case 'webp': {
        const kind = ascii(b, 12, 16);
        if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
        if (kind === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
        if (kind === 'VP8L') {
          const bits = v.getUint32(21, true);
          return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        return null;
      }
      case 'jpeg': {
        let p = 2;
        while (p + 9 < b.length) {
          if (b[p] !== 0xff) return null;
          const marker = b[p + 1]!;
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: v.getUint16(p + 5), width: v.getUint16(p + 7) };
          p += 2 + v.getUint16(p + 2);
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Larger images are not decoded: a small file can unpack to gigabytes of pixels. */
export const MAX_PIXELS = 80_000_000;
