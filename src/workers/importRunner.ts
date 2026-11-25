import type { SourceRequest } from '../core/import/sources';
import type { ImportProgress } from '../core/project/storage';
import type { ImportReply, ImportRequest } from './import.worker';

export class ImportCancelled extends Error {}

export interface ImportRun {
  readonly done: Promise<readonly string[]>;
  readonly cancel: () => void;
}

/** Runs an import in its own worker, which ends with it. */
export function runImport(request: { source: SourceRequest; resume?: string }, onProgress: (name: string, p: ImportProgress | null) => void): ImportRun {
  const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
  const post = (m: ImportRequest) => worker.postMessage(m);
  const done = new Promise<readonly string[]>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ImportReply>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.name, m.progress);
      else {
        worker.terminate();
        if (m.type === 'done') resolve(m.ids);
        else reject(m.cancelled ? new ImportCancelled() : new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new Error(e.message || 'The import stopped unexpectedly. What was already read is kept: you can resume it.'));
    };
  });
  post(request.resume ? { type: 'resume', id: request.resume, source: request.source } : { type: 'import', source: request.source });
  return { done, cancel: () => post({ type: 'cancel' }) };
}
