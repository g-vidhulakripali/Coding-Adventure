import { decodeText, planImport, readPlanned } from '../import/importProject';
import { ANALYSIS_LIMITS } from '../import/limits';
import type { ImportSource } from '../import/sources';
import type { LeftOut, ProjectSource, RepositoryFile } from '../repository/types';

/**
 * Imported projects, kept in this browser (IndexedDB). Nothing leaves the device.
 * File contents are stored as the original bytes under their original paths.
 */

const DB_NAME = 'code-playground';
const BATCH_BYTES = 8 * 1024 ** 2;
const BATCH_FILES = 100;

interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly bytes: number;
  readonly files: readonly RepositoryFile[];
  readonly leftOut: LeftOut;
}

export interface SavedProject {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly bytes: number;
  readonly fileCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not allow saving projects here.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('The browser storage could not be opened.'));
    request.onblocked = () => reject(new Error('The browser storage is in use by another tab.'));
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The browser storage failed.'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error?.name === 'QuotaExceededError' ? new Error('There is not enough free browser storage for this project.') : (tx.error ?? new Error('The browser storage failed.')));
  });
}

const filesOf = (id: string) => IDBKeyRange.bound([id], [id, []]);

export interface ImportProgress {
  readonly done: number;
  readonly total: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly path: string;
}

/** Checks, reads and saves a project. On failure or cancel, nothing half-imported remains. */
export async function importProject(source: ImportSource, onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<string> {
  const plan = planImport(source);
  if (plan.files.length === 0) {
    const reason = plan.leftOut.refused[0]?.reason;
    throw new Error(reason ? `Nothing could be imported: ${reason}.` : 'There are no files to import here.');
  }
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (estimate?.quota !== undefined && estimate.usage !== undefined && plan.bytes > estimate.quota - estimate.usage) {
    throw new Error(`The project needs ${Math.ceil(plan.bytes / 1024 ** 2)} MB, but this browser has only ${Math.floor((estimate.quota - estimate.usage) / 1024 ** 2)} MB left.`);
  }
  const db = await open();
  const id = crypto.randomUUID();
  const refused = [...plan.leftOut.refused];
  const kept: RepositoryFile[] = [];
  let batch: Array<{ path: string; blob: Blob }> = [];
  let batchBytes = 0;
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const tx = db.transaction('files', 'readwrite');
    const done = finished(tx);
    for (const f of batch) tx.objectStore('files').put(f.blob, [id, f.path]);
    batch = [];
    batchBytes = 0;
    await done;
  };
  try {
    for await (const { file, blob } of readPlanned(plan, refused, signal)) {
      kept.push(file);
      if (blob) {
        batch.push({ path: file.path, blob });
        batchBytes += blob.size;
        bytes += blob.size;
      }
      if (batchBytes > BATCH_BYTES || batch.length >= BATCH_FILES) await flush();
      onProgress({ done: kept.length, total: plan.files.length, bytes, totalBytes: plan.bytes, path: file.path });
    }
    await flush();
    const record: ProjectRecord = { id, name: plan.name, savedAt: Date.now(), bytes, files: kept, leftOut: { folders: plan.leftOut.folders, refused } };
    const tx = db.transaction('projects', 'readwrite');
    const done = finished(tx);
    tx.objectStore('projects').put(record);
    await done;
  } catch (err) {
    await removeProject(id).catch(() => undefined);
    throw err;
  }
  // Ask the browser to keep the data even when disk space gets low (it may say no).
  void navigator.storage?.persist?.().catch(() => undefined);
  return id;
}

export async function listProjects(): Promise<SavedProject[]> {
  const db = await open();
  const records = await result(db.transaction('projects').objectStore('projects').getAll() as IDBRequest<ProjectRecord[]>);
  return records
    .map((r) => ({ id: r.id, name: r.name, savedAt: r.savedAt, bytes: r.bytes, fileCount: r.files.length }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function removeProject(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(['projects', 'files'], 'readwrite');
  const done = finished(tx);
  tx.objectStore('projects').delete(id);
  tx.objectStore('files').delete(filesOf(id));
  await done;
}

export async function loadSavedProject(id: string): Promise<ProjectSource | null> {
  const db = await open();
  const record = await result(db.transaction('projects').objectStore('projects').get(id) as IDBRequest<ProjectRecord | undefined>);
  if (!record) return null;
  const byPath = new Map(record.files.map((f) => [f.path, f]));
  return {
    id: record.id,
    name: record.name,
    origin: 'import',
    files: record.files,
    leftOut: record.leftOut,
    async readText(path) {
      const file = byPath.get(path);
      if (!file) throw new Error(`This project has no file at “${path}”.`);
      if (file.size > ANALYSIS_LIMITS.viewerBytes) throw new Error(`${file.name} is ${(file.size / 1024 ** 2).toFixed(1)} MB, which is too large to show as text.`);
      const blob = await result(db.transaction('files').objectStore('files').get([id, path]) as IDBRequest<Blob | undefined>);
      if (!blob) throw new Error(file.note ?? 'The content of this file is not stored.');
      return decodeText(blob);
    },
  };
}
