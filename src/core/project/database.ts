/** The browser database. Works in the page and in workers. */

const DB_NAME = 'code-playground';
const DB_VERSION = 2;

export type StoreName = 'projects' | 'files' | 'analysis' | 'archives';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not allow saving projects here.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      // Keys are [project, path]; values are the original bytes or the stored analysis.
      for (const name of ['files', 'analysis', 'archives'] as const) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('The browser storage could not be opened.'));
    request.onblocked = () => reject(new Error('The browser storage is in use by an older tab of this app. Close the other tabs and try again.'));
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error));
  });
}

export function storageError(err: unknown): Error {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return new Error('There is not enough free browser storage for this project. Remove a saved project or free some disk space, then try again.');
  return err instanceof Error ? err : new Error('The browser storage failed.');
}

export function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(storageError(tx.error));
  });
}

/** All keys of one project. */
export const ofProject = (id: string) => IDBKeyRange.bound([id], [id, []]);

/** One write transaction; resolves when the data is safely stored. */
export async function write(stores: StoreName | readonly StoreName[], work: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(stores as StoreName | StoreName[], 'readwrite');
  const done = finished(tx);
  try {
    work(tx);
  } catch (err) {
    done.catch(() => undefined);
    throw storageError(err);
  }
  await done;
}

export async function readOne<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase();
  return result(db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function readAll<T>(store: StoreName, range?: IDBKeyRange): Promise<T[]> {
  const db = await openDatabase();
  return result(db.transaction(store).objectStore(store).getAll(range) as IDBRequest<T[]>);
}

export async function readKeys(store: StoreName, range?: IDBKeyRange): Promise<IDBValidKey[]> {
  const db = await openDatabase();
  return result(db.transaction(store).objectStore(store).getAllKeys(range));
}
