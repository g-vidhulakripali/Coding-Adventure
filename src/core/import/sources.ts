import { IMPORT_LIMITS, isLeftOutFolder } from './limits';
import { readZip } from './zip';

/** One file offered for import. Nothing is read until `read()` is called. */
export interface Candidate {
  readonly rawPath: string;
  readonly size: number;
  /** Why this file cannot be imported, when that is already known. */
  readonly problem?: string | null;
  read(): Promise<Blob>;
}

export interface ImportSource {
  readonly name: string;
  readonly candidates: readonly Candidate[];
  /** Folders that were not opened at all (their files could not be counted). */
  readonly unopened: readonly string[];
  /** The ZIP this comes from, so an interrupted import can continue. */
  readonly archive?: File;
  /** The folder this comes from, likewise. */
  readonly handle?: DirHandle;
}

/** What the page hands to the import worker. */
export type SourceRequest =
  | { readonly kind: 'zip'; readonly file: File }
  | { readonly kind: 'folder'; readonly handle: DirHandle }
  | { readonly kind: 'files'; readonly files: ReadonlyArray<{ readonly path: string; readonly file: File }>; readonly unopened: readonly string[]; readonly name: string };

export async function openSource(request: SourceRequest): Promise<{ kind: 'project'; source: ImportSource } | { kind: 'backup'; file: File }> {
  if (request.kind === 'zip') {
    const { isBackup } = await import('../project/backup');
    if (isBackup(await readZip(request.file))) return { kind: 'backup', file: request.file };
    return { kind: 'project', source: await fromZip(request.file) };
  }
  if (request.kind === 'folder') return { kind: 'project', source: await fromDirectory(request.handle) };
  return { kind: 'project', source: { name: request.name, unopened: request.unopened, candidates: request.files.map(({ path, file }) => ({ rawPath: path, size: file.size, read: () => Promise.resolve(file as Blob) })) } };
}

const stripZip = (name: string) => name.replace(/\.zip$/i, '') || 'project';

export async function fromZip(file: File): Promise<ImportSource> {
  const entries = await readZip(file);
  return {
    name: stripZip(file.name),
    candidates: entries.filter((e) => !e.isDirectory).map((e) => ({ rawPath: e.rawPath, size: e.size, problem: e.problem, read: () => e.extract() })),
    unopened: [],
    archive: file,
  };
}

/** Files from `<input webkitdirectory>`; their paths start with the chosen folder's name. */
export function requestFromFileList(files: readonly File[]): SourceRequest {
  const list = files.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
  return { kind: 'files', files: list, unopened: [], name: list[0]?.path.split('/')[0] ?? 'project' };
}

/** The parts of the File System Access API used here (not yet in every TypeScript DOM library). */
export interface DirHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
}
interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

export function canPickFolder(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Asks for a folder (read-only). Null when the user cancels. */
export async function pickFolder(): Promise<SourceRequest | null> {
  const pick = (window as unknown as { showDirectoryPicker: (o: { mode: 'read' }) => Promise<DirHandle> }).showDirectoryPicker;
  try {
    return { kind: 'folder', handle: await pick({ mode: 'read' }) };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Lists a folder without reading file contents. Tool folders are not opened. */
export async function fromDirectory(root: DirHandle): Promise<ImportSource> {
  const candidates: Candidate[] = [];
  const unopened: string[] = [];
  const walk = async (dir: DirHandle, path: string): Promise<void> => {
    for await (const item of dir.values()) {
      const at = `${path}/${item.name}`;
      if (item.kind === 'directory') {
        if (isLeftOutFolder(item.name)) unopened.push(at);
        else await walk(item, at);
      } else if (candidates.length <= IMPORT_LIMITS.files) {
        const file = await item.getFile();
        candidates.push({ rawPath: at, size: file.size, read: () => item.getFile() });
      }
    }
  };
  await walk(root, root.name);
  return { name: root.name, candidates, unopened, handle: root };
}

/** A dropped ZIP, folder or set of files. Must be called synchronously in the drop handler. */
export function fromDrop(data: DataTransfer): Promise<SourceRequest | null> {
  const entries = [...data.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry() : null)).filter((e): e is FileSystemEntry => e !== null);
  const dropped = [...data.files];
  return (async () => {
    if (dropped.length === 1 && entries.every((e) => !e.isDirectory) && /\.zip$/i.test(dropped[0]!.name)) return { kind: 'zip', file: dropped[0]! };
    if (entries.length === 0) return null;
    const files: Array<{ path: string; file: File }> = [];
    const unopened: string[] = [];
    const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
      if (entry.isFile) {
        if (files.length > IMPORT_LIMITS.files) return;
        files.push({ path, file: await new Promise<File>((ok, no) => (entry as FileSystemFileEntry).file(ok, no)) });
        return;
      }
      if (isLeftOutFolder(entry.name)) {
        unopened.push(path);
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${path}/${child.name}`);
      }
    };
    for (const e of entries) await walk(e, e.name);
    return { kind: 'files', files, unopened, name: entries[0]!.name };
  })();
}
