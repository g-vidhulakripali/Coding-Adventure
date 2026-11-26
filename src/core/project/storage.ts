import type { FileAnalysis } from '../analysis/python/fileAnalysis';
import { decodeText, planImport, readPlanned } from '../import/importProject';
import { ANALYSIS_LIMITS } from '../import/limits';
import type { DirHandle, ImportSource, SourceRequest } from '../import/sources';
import type { LeftOut, ProjectSource, RepositoryFile } from '../repository/types';
import { ofProject, openDatabase, readAll, readKeys, readOne, result, write } from './database';

/**
 * Imported projects, kept in this browser. Nothing leaves the device. File contents
 * are stored as the original bytes under their original paths.
 *
 * An import first stores what it needs to continue (the ZIP, or permission to the
 * chosen folder). If the browser closes in between, it can be resumed and only the
 * missing files are read again.
 */

const BATCH_BYTES = 8 * 1024 ** 2;
const BATCH_FILES = 100;
/** The longest a closed tab may take to let go of its import (Chrome can take several seconds under load). */
const LOCK_WAIT_MS = 30_000;
/** A tab that still answers after this long is really importing, not closing. */
const BUSY_AFTER_MS = 2000;
const PING_MS = 500;

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly bytes: number;
  readonly files: readonly RepositoryFile[];
  readonly leftOut: LeftOut;
  /** Missing on projects saved by earlier versions of the app, which were always complete. */
  readonly status?: 'ready' | 'importing';
  readonly total?: number;
}

export interface SavedProject {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly bytes: number;
  readonly fileCount: number;
  readonly unfinished: { readonly done: number; readonly total: number; readonly resumable: boolean } | null;
}

export interface ImportProgress {
  readonly done: number;
  readonly total: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly path: string;
}

/** What an import can be continued from. */
type Archive = { readonly kind: 'zip'; readonly name: string; readonly blob: Blob } | { readonly kind: 'opfs'; readonly name: string; readonly file: string } | { readonly kind: 'folder'; readonly handle: DirHandle };

// ---- Temporary copy of the ZIP, for resuming ------------------------------------------

async function opfs(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('imports', { create: true });
  } catch {
    return null;
  }
}

/** Large archives go to the origin private file system (written in pieces); elsewhere to the database. */
async function keepArchive(id: string, file: File): Promise<void> {
  const dir = await opfs();
  if (dir) {
    try {
      const handle = await dir.getFileHandle(id, { create: true });
      const target = await handle.createWritable();
      await file.stream().pipeTo(target);
      await write('archives', (tx) => tx.objectStore('archives').put({ kind: 'opfs', name: file.name, file: id } satisfies Archive, id));
      return;
    } catch {
      await dir.removeEntry(id).catch(() => undefined);
    }
  }
  await write('archives', (tx) => tx.objectStore('archives').put({ kind: 'zip', name: file.name, blob: file } satisfies Archive, id));
}

async function dropArchive(id: string): Promise<void> {
  const dir = await opfs();
  await dir?.removeEntry(id).catch(() => undefined);
  await write('archives', (tx) => tx.objectStore('archives').delete(id)).catch(() => undefined);
}

// ---- Import ---------------------------------------------------------------------------

export interface SpaceCheck {
  readonly needed: number;
  readonly free: number | null;
  readonly verdict: 'fits' | 'tight' | 'too-large' | 'unknown';
}

/** Compares what an import needs (including the temporary copy of a ZIP) with the free browser storage. */
export async function checkSpace(needed: number): Promise<SpaceCheck> {
  const e = await navigator.storage?.estimate?.().catch(() => null);
  if (!e || e.quota === undefined || e.usage === undefined) return { needed, free: null, verdict: 'unknown' };
  const free = Math.max(0, e.quota - e.usage);
  return { needed, free, verdict: needed > free ? 'too-large' : needed > free * 0.8 ? 'tight' : 'fits' };
}

/**
 * Holds a lock while importing, so that another tab does not "resume" a running import.
 *
 * The browser keeps the lock of a just-closed tab for a while (its worker no longer runs,
 * but has not been torn down yet). To tell that apart from a tab that really is importing,
 * the holder answers pings on a BroadcastChannel: a live holder makes us give up quickly,
 * a silent one is waited for.
 */
async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return work();
  const name = `import:${id}`;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
  const waiting = new AbortController();
  const start = Date.now();
  let answered = -Infinity;
  let busy = false;
  if (channel) channel.onmessage = (e: MessageEvent) => void (e.data === 'busy' && (answered = Date.now()));
  const check = () => {
    const now = Date.now();
    if (now - start >= BUSY_AFTER_MS && now - answered < PING_MS * 2) {
      busy = true;
      waiting.abort();
    } else if (now - start >= LOCK_WAIT_MS) waiting.abort();
    else channel?.postMessage('ping');
  };
  const timer = setInterval(check, PING_MS);
  channel?.postMessage('ping');
  try {
    return (await navigator.locks.request(name, { signal: waiting.signal }, () => {
      clearInterval(timer);
      // This tab is now the one importing: tell anyone who asks.
      if (channel) channel.onmessage = (e: MessageEvent) => void (e.data === 'ping' && channel.postMessage('busy'));
      return work();
    })) as T;
  } catch (err) {
    if (waiting.signal.aborted) throw new Error(busy ? 'This import is already running in another tab.' : 'A closed tab has not let go of this import yet. Try again in a moment.');
    throw err;
  } finally {
    clearInterval(timer);
    channel?.close();
  }
}

/** Checks, reads and saves a project. Cancelling removes it again; a crash leaves it resumable. */
export async function importProject(source: ImportSource, onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<string> {
  const plan = planImport(source);
  if (plan.files.length === 0) {
    const reason = plan.leftOut.refused[0]?.reason;
    throw new Error(reason ? `Nothing could be imported: ${reason}.` : 'There are no files to import here.');
  }
  const space = await checkSpace(plan.bytes + (source.archive?.size ?? 0));
  if (space.verdict === 'too-large') throw new Error(`The project needs about ${Math.ceil(space.needed / 1024 ** 2)} MB while importing, but this browser has only ${Math.floor(space.free! / 1024 ** 2)} MB left.`);
  const id = crypto.randomUUID();
  return locked(id, async () => {
    try {
      const record: ProjectRecord = { id, name: plan.name, savedAt: Date.now(), bytes: 0, files: [], leftOut: plan.leftOut, status: 'importing', total: plan.files.length };
      await write('projects', (tx) => tx.objectStore('projects').put(record));
      if (source.archive) await keepArchive(id, source.archive);
      else if (source.handle) await write('archives', (tx) => tx.objectStore('archives').put({ kind: 'folder', handle: source.handle! } satisfies Archive, id)).catch(() => undefined);
      await store(id, source, new Set(), onProgress, signal);
    } catch (err) {
      await removeProject(id).catch(() => undefined);
      throw err;
    }
    return id;
  });
}

async function store(id: string, source: ImportSource, have: ReadonlySet<string>, onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<void> {
  const plan = planImport(source);
  const refused = [...plan.leftOut.refused];
  const kept: RepositoryFile[] = [];
  let batch: Array<{ path: string; blob: Blob }> = [];
  let batchBytes = 0;
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const now = batch;
    batch = [];
    batchBytes = 0;
    await write('files', (tx) => {
      for (const f of now) tx.objectStore('files').put(f.blob, [id, f.path]);
    });
  };
  for await (const { file, blob, size } of readPlanned(plan, refused, signal, have)) {
    kept.push(file);
    bytes += size;
    if (blob) {
      batch.push({ path: file.path, blob });
      batchBytes += blob.size;
    }
    if (batchBytes > BATCH_BYTES || batch.length >= BATCH_FILES) await flush();
    onProgress({ done: kept.length, total: plan.files.length, bytes, totalBytes: plan.bytes, path: file.path });
  }
  await flush();
  const record: ProjectRecord = { id, name: plan.name, savedAt: Date.now(), bytes, files: kept, leftOut: { folders: plan.leftOut.folders, refused }, status: 'ready' };
  await write('projects', (tx) => tx.objectStore('projects').put(record));
  await dropArchive(id);
  // Ask the browser to keep the data even when disk space gets low (it may say no).
  void navigator.storage?.persist?.().catch(() => undefined);
}

/** Opens what an interrupted import came from again. Asks for folder permission when needed (call it from a click). */
export async function reopenRequest(id: string): Promise<SourceRequest> {
  const archive = await readOne<Archive>('archives', id);
  if (!archive) throw new Error('What this project was imported from is no longer available. Remove it and import it again.');
  if (archive.kind === 'folder') {
    const h = archive.handle as DirHandle & { requestPermission?: (o: { mode: 'read' }) => Promise<string> };
    if (h.requestPermission && (await h.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Reading the folder was not allowed.');
    return { kind: 'folder', handle: archive.handle };
  }
  if (archive.kind === 'zip') return { kind: 'zip', file: new File([archive.blob], archive.name) };
  const dir = await opfs();
  const handle = await dir?.getFileHandle(archive.file).catch(() => null);
  if (!handle) throw new Error('The temporary copy of the ZIP is gone. Remove this project and import it again.');
  return { kind: 'zip', file: new File([await handle.getFile()], archive.name) };
}

export async function resumeImport(id: string, source: ImportSource, onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<void> {
  await locked(id, async () => {
    const keys = await readKeys('files', ofProject(id));
    await store(id, source, new Set(keys.map((k) => (k as string[])[1]!)), onProgress, signal);
  });
}

// ---- Library --------------------------------------------------------------------------

export async function listProjects(): Promise<SavedProject[]> {
  const records = await readAll<ProjectRecord>('projects');
  const out: SavedProject[] = [];
  for (const r of records) {
    let unfinished: SavedProject['unfinished'] = null;
    if (r.status === 'importing') {
      const done = (await readKeys('files', ofProject(r.id))).length;
      unfinished = { done, total: r.total ?? 0, resumable: (await readOne('archives', r.id)) !== undefined };
    }
    out.push({ id: r.id, name: r.name, savedAt: r.savedAt, bytes: r.bytes, fileCount: r.files.length, unfinished });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export async function removeProject(id: string): Promise<void> {
  await write(['projects', 'files', 'analysis'], (tx) => {
    tx.objectStore('projects').delete(id);
    tx.objectStore('files').delete(ofProject(id));
    tx.objectStore('analysis').delete(ofProject(id));
  });
  await dropArchive(id);
}

export interface StorageOverview {
  readonly usage: number | null;
  readonly quota: number | null;
  /** Whether the browser promised to keep the data. */
  readonly kept: boolean | null;
}

export async function storageOverview(): Promise<StorageOverview> {
  const e = await navigator.storage?.estimate?.().catch(() => null);
  const kept = await navigator.storage?.persisted?.().catch(() => null);
  return { usage: e?.usage ?? null, quota: e?.quota ?? null, kept: kept ?? null };
}

export async function askToKeep(): Promise<boolean> {
  return (await navigator.storage?.persist?.().catch(() => false)) ?? false;
}

// ---- Reading ---------------------------------------------------------------------------

export async function readRecord(id: string): Promise<ProjectRecord | undefined> {
  return readOne<ProjectRecord>('projects', id);
}

export async function readBlob(id: string, path: string): Promise<Blob | undefined> {
  return readOne<Blob>('files', [id, path]);
}

export async function loadAnalyses(id: string): Promise<Map<string, FileAnalysis>> {
  const db = await openDatabase();
  const store = db.transaction('analysis').objectStore('analysis');
  const all = await result(store.getAll(ofProject(id)) as IDBRequest<FileAnalysis[]>);
  return new Map(all.map((a) => [a.path, a]));
}

export async function saveAnalysis(id: string, a: FileAnalysis): Promise<void> {
  // The project may have been removed while its analysis was still running.
  if (!(await readRecord(id))) return;
  await write('analysis', (tx) => tx.objectStore('analysis').put(a, [id, a.path]));
}

export async function loadSavedProject(id: string): Promise<ProjectSource | null> {
  const record = await readRecord(id);
  if (!record || record.status === 'importing') return null;
  const byPath = new Map(record.files.map((f) => [f.path, f]));
  const blobOf = async (path: string): Promise<Blob> => {
    const file = byPath.get(path);
    if (!file) throw new Error(`This project has no file at “${path}”.`);
    const blob = await readBlob(id, path);
    if (!blob) throw new Error(file.note ?? 'The content of this file is not stored.');
    return blob;
  };
  return {
    id: record.id,
    name: record.name,
    origin: 'import',
    files: record.files,
    leftOut: record.leftOut,
    readBlob: blobOf,
    async readText(path) {
      const file = byPath.get(path);
      if (file && file.size > ANALYSIS_LIMITS.viewerBytes) throw new Error(`${file.name} is ${(file.size / 1024 ** 2).toFixed(1)} MB, which is too large to show as text.`);
      return decodeText(await blobOf(path));
    },
    analysisStore: { load: () => loadAnalyses(id), save: (a) => saveAnalysis(id, a) },
  };
}
