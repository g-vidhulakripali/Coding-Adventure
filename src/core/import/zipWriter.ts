import { crc32 } from './zip';

/**
 * Writes a ZIP piece by piece: one file is in memory at a time, the rest are
 * references to blobs the browser keeps on disk.
 */
export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly central: Uint8Array<ArrayBuffer>[] = [];
  private offset = 0;
  private count = 0;

  async add(path: string, content: Blob | string): Promise<void> {
    const blob = typeof content === 'string' ? new Blob([content]) : content;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes);
    const packedStream = (new Blob([bytes]).stream() as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(new CompressionStream('deflate-raw'));
    let packed = new Uint8Array(await new Response(packedStream).arrayBuffer());
    // Already compressed files (images, archives) only grow: store them as they are.
    const deflated = packed.length < bytes.length;
    if (!deflated) packed = bytes;
    const name = new TextEncoder().encode(path);
    if (this.offset + packed.length > 0xfffffff0 || this.count >= 0xfff0) throw new Error('This is too large for one backup file (limit 4 GB).');

    const header = (signature: number, length: number, shift: number) => {
      const v = new DataView(new ArrayBuffer(length));
      v.setUint32(0, signature, true);
      v.setUint16(4 + shift, 20, true);
      v.setUint16(6 + shift, 0x800, true); // UTF-8 names
      v.setUint16(8 + shift, deflated ? 8 : 0, true);
      v.setUint32(14 + shift, crc, true);
      v.setUint32(18 + shift, packed.length, true);
      v.setUint32(22 + shift, bytes.length, true);
      v.setUint16(26 + shift, name.length, true);
      return v;
    };
    const local = header(0x04034b50, 30, 0);
    const dir = header(0x02014b50, 46, 2);
    dir.setUint16(4, 20, true);
    dir.setUint32(42, this.offset, true);
    this.parts.push(new Blob([local.buffer as ArrayBuffer, name, packed]));
    this.central.push(new Uint8Array(dir.buffer as ArrayBuffer), name);
    this.offset += 30 + name.length + packed.length;
    this.count++;
  }

  finish(): Blob {
    const size = this.central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer as ArrayBuffer], { type: 'application/zip' });
  }
}
