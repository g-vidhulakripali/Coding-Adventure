/// <reference lib="webworker" />
import { importBackup } from '../core/project/backup';
import { importProject, resumeImport, type ImportProgress } from '../core/project/storage';
import { openSource, type SourceRequest } from '../core/import/sources';

export type ImportRequest = { readonly type: 'import'; readonly source: SourceRequest } | { readonly type: 'resume'; readonly id: string; readonly source: SourceRequest } | { readonly type: 'cancel' };
export type ImportReply = { readonly type: 'progress'; readonly name: string; readonly progress: ImportProgress | null } | { readonly type: 'done'; readonly ids: readonly string[] } | { readonly type: 'failed'; readonly message: string; readonly cancelled: boolean };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const abort = new AbortController();
const send = (m: ImportReply) => scope.postMessage(m);

/** Reads, checks, unpacks and stores a project away from the page. */
self.onmessage = (e: MessageEvent<ImportRequest>) => {
  const request = e.data;
  if (request.type === 'cancel') {
    abort.abort();
    return;
  }
  void (async () => {
    try {
      const opened = await openSource(request.source);
      let shown = 0;
      const progress = (name: string) => (p: ImportProgress) => {
        const now = performance.now();
        if (now - shown < 80 && p.done < p.total) return;
        shown = now;
        send({ type: 'progress', name, progress: p });
      };
      if (opened.kind === 'backup') {
        const ids = await importBackup(opened.file, (done, total) => progress('backup')({ done, total, bytes: 0, totalBytes: 0, path: '' }), abort.signal);
        send({ type: 'done', ids });
        return;
      }
      send({ type: 'progress', name: opened.source.name, progress: null });
      if (request.type === 'resume') {
        await resumeImport(request.id, opened.source, progress(opened.source.name), abort.signal);
        send({ type: 'done', ids: [request.id] });
      } else send({ type: 'done', ids: [await importProject(opened.source, progress(opened.source.name), abort.signal)] });
    } catch (err) {
      send({ type: 'failed', message: err instanceof Error ? err.message : String(err), cancelled: abort.signal.aborted });
    }
  })();
};
