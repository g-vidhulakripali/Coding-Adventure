import { detectCategory, extensionOf, fileNameOf } from '../repository/fileTypes';
import type { LeftOut, RepositoryFile } from '../repository/types';
import { checkPath, IMPORT_LIMITS, leftOutFolderOf } from './limits';
import type { Candidate, ImportSource } from './sources';

const ARCHIVES = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'whl', 'egg', 'jar']);

export interface ImportPlan {
  readonly name: string;
  readonly files: readonly PlannedFile[];
  readonly leftOut: LeftOut;
  readonly bytes: number;
}

export interface PlannedFile {
  readonly file: RepositoryFile;
  /** Null when the content is not kept (the file is still listed). */
  readonly candidate: Candidate | null;
}

/**
 * Decides what is imported, before anything is unpacked. Every offered file ends
 * up either in `files` or, with a reason, in `leftOut`.
 */
export function planImport(source: ImportSource): ImportPlan {
  const folders = new Map<string, { files: number; bytes: number }>(source.unopened.map((p) => [p, { files: 0, bytes: 0 }]));
  const refused: Array<{ path: string; reason: string }> = [];
  const files: PlannedFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const c of source.candidates) {
    const check = checkPath(c.rawPath);
    if (!check.ok) {
      refused.push({ path: c.rawPath.slice(0, 200), reason: check.reason });
      continue;
    }
    const folder = leftOutFolderOf(check.path);
    if (folder) {
      const entry = folders.get(folder) ?? { files: 0, bytes: 0 };
      folders.set(folder, { files: entry.files + 1, bytes: entry.bytes + c.size });
      continue;
    }
    if (c.problem) {
      refused.push({ path: check.path, reason: c.problem });
      continue;
    }
    if (seen.has(check.path)) {
      refused.push({ path: check.path, reason: 'the same path appears twice' });
      continue;
    }
    if (files.length >= IMPORT_LIMITS.files) {
      refused.push({ path: check.path, reason: `the project has more than ${IMPORT_LIMITS.files.toLocaleString('en')} files` });
      continue;
    }
    seen.add(check.path);
    const note =
      c.size > IMPORT_LIMITS.fileBytes
        ? `Not stored: larger than ${IMPORT_LIMITS.fileBytes / 1024 ** 2} MB.`
        : bytes + c.size > IMPORT_LIMITS.totalBytes
          ? 'Not stored: the project is larger than the size limit.'
          : null;
    if (!note) bytes += c.size;
    const isArchive = ARCHIVES.has(extensionOf(fileNameOf(check.path)));
    files.push({
      file: {
        path: check.path,
        name: fileNameOf(check.path),
        size: c.size,
        category: detectCategory(check.path),
        ...(note ? { note } : isArchive ? { note: 'This is an archive. It is kept as one file and not opened.' } : {}),
      },
      candidate: note ? null : c,
    });
  }
  return { name: source.name, files, leftOut: { folders: [...folders].map(([path, n]) => ({ path, ...n })), refused }, bytes };
}

export interface ReadFile {
  readonly file: RepositoryFile;
  readonly blob: Blob | null;
}

/** Reads the planned files one by one; a file that fails is reported and the rest continues. */
export async function* readPlanned(plan: ImportPlan, refused: Array<{ path: string; reason: string }>, signal?: AbortSignal): AsyncGenerator<ReadFile> {
  for (const { file, candidate } of plan.files) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    if (!candidate) {
      yield { file, blob: null };
      continue;
    }
    try {
      const blob = await candidate.read();
      // Copy the bytes: a File from disk would change (or vanish) with the original.
      yield { file, blob: new Blob([await blob.arrayBuffer()]) };
    } catch (err) {
      refused.push({ path: file.path, reason: err instanceof Error ? err.message : 'it could not be read' });
      yield { file: { ...file, note: 'Not stored: it could not be read.' }, blob: null };
    }
  }
}

/** Decodes text honestly: refuses binary content whatever the file is called. */
export async function decodeText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  if (utf16) return new TextDecoder(utf16).decode(bytes);
  if (bytes.subarray(0, 8192).includes(0)) throw new Error('This file holds binary data, whatever its name says, so it is not shown as text.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
