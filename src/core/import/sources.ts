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
}

const stripZip = (name: string) => name.replace(/\.zip$/i, '') || 'project';

export async function fromZip(file: File): Promise<ImportSource> {
  const entries = await readZip(file);
  return {
    name: stripZip(file.name),
    candidates: entries.filter((e) => !e.isDirectory).map((e) => ({ rawPath: e.rawPath, size: e.size, problem: e.problem, read: () => e.extract() })),
    unopened: [],
  };
}

/** Files from `<input webkitdirectory>`; their paths start with the chosen folder's name. */
export function fromFileList(files: readonly File[]): ImportSource {
  const candidates = files.map((f) => ({ rawPath: f.webkitRelativePath || f.name, size: f.size, read: () => Promise.resolve(f as Blob) }));
  return { name: candidates[0]?.rawPath.split('/')[0] ?? 'project', candidates, unopened: [] };
}

/** The parts of the File System Access API used here (not yet in every TypeScript DOM library). */
interface DirHandle {
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

/** Asks for a folder (read-only). Null when the user cancels. Tool folders are not opened. */
export async function pickFolder(): Promise<ImportSource | null> {
  const pick = (window as unknown as { showDirectoryPicker: (o: { mode: 'read' }) => Promise<DirHandle> }).showDirectoryPicker;
  let root: DirHandle;
  try {
    root = await pick({ mode: 'read' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
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
        candidates.push({ rawPath: at, size: file.size, read: () => Promise.resolve(file) });
      }
    }
  };
  await walk(root, root.name);
  return { name: root.name, candidates, unopened };
}

/** A dropped ZIP, folder or set of files. Must be called synchronously in the drop handler. */
export function fromDrop(data: DataTransfer): Promise<ImportSource | null> {
  const entries = [...data.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry() : null)).filter((e): e is FileSystemEntry => e !== null);
  const files = [...data.files];
  return (async () => {
    if (files.length === 1 && entries.every((e) => !e.isDirectory) && /\.zip$/i.test(files[0]!.name)) return fromZip(files[0]!);
    if (entries.length === 0) return null;
    const candidates: Candidate[] = [];
    const unopened: string[] = [];
    const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
      if (entry.isFile) {
        if (candidates.length > IMPORT_LIMITS.files) return;
        const file = await new Promise<File>((ok, no) => (entry as FileSystemFileEntry).file(ok, no));
        candidates.push({ rawPath: path, size: file.size, read: () => Promise.resolve(file) });
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
    return { name: entries[0]!.name, candidates, unopened };
  })();
}
