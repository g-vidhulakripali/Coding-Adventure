import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { canPickFolder, fromDrop, pickFolder, requestFromFileList, type SourceRequest } from '../../core/import/sources';
import type { ImportProgress } from '../../core/project/storage';
import { ImportCancelled, runImport, type ImportRun } from '../../workers/importRunner';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';
import './ImportCard.css';

export interface ImportJob {
  readonly request: () => Promise<SourceRequest | null>;
  /** Project whose interrupted import continues. */
  readonly resume?: string;
}

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'reading' }
  | { readonly status: 'saving'; readonly name: string; readonly progress: ImportProgress | null; readonly startedAt: number }
  | { readonly status: 'error'; readonly message: string };

/** Choose or drop a folder, a ZIP or a backup. Everything is checked and saved in this browser only. */
export function ImportCard({ job, onImported, onChanged }: { job: ImportJob | null; onImported: (ids: readonly string[]) => void; onChanged: () => void }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [over, setOver] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const run = useRef<ImportRun | null>(null);
  const mounted = useRef(true);
  const busy = state.status === 'reading' || state.status === 'saving';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(
    async ({ request, resume }: ImportJob) => {
      setState({ status: 'reading' });
      try {
        const source = await request();
        if (!source) {
          setState({ status: 'idle' });
          return;
        }
        const startedAt = performance.now();
        run.current = runImport({ source, ...(resume ? { resume } : {}) }, (name, progress) => {
          if (mounted.current) setState({ status: 'saving', name, progress, startedAt });
        });
        const ids = await run.current.done;
        if (mounted.current) {
          setState({ status: 'idle' });
          onImported(ids);
        }
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ImportCancelled) setState({ status: 'idle' });
        else setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        onChanged();
      }
    },
    [onImported, onChanged],
  );

  useEffect(() => {
    if (job) void start(job);
  }, [job, start]);

  const chooseFolder = () => {
    if (canPickFolder()) void start({ request: pickFolder });
    else folderInput.current?.click();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (busy) return;
    const request = fromDrop(e.dataTransfer);
    void start({ request: () => request });
  };

  const p = state.status === 'saving' ? state.progress : null;
  return (
    <article
      className={`file-card file-card--active import-card${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="file-card__tab">
        <span style={{ color: 'var(--lab-variable)' }}>
          <Icon name="upload" />
        </span>
        import_project.py
      </div>
      <div className="file-card__body">
        <h2>Import your own project</h2>
        <p>
          <span className="tok tok--c"># </span>
          Choose a folder, a ZIP or a backup, or drop it here. It stays in this browser and is never run.
        </p>
        {busy ? (
          <div className="import-card__progress" role="status" aria-live="polite">
            <span className="import-card__what">
              {state.status === 'reading' || !p ? 'looking at the files…' : `${p.done}/${p.total} files${p.bytes ? ` · ${formatBytes(p.bytes)}` : ''}${state.status === 'saving' ? ` · ${eta(p, state.startedAt)}` : ''}`}
            </span>
            <progress max={p?.total ?? 1} value={p?.done ?? undefined} aria-label="Import progress" />
            <span className="import-card__path">{p?.path ?? ''}</span>
            <button type="button" className="btn btn--ghost" onClick={() => run.current?.cancel()}>
              cancel
            </button>
          </div>
        ) : (
          <div className="import-card__buttons">
            <button type="button" className="btn btn--primary" onClick={chooseFolder}>
              <Icon name="folder" /> choose folder
            </button>
            <button type="button" className="btn" onClick={() => zipInput.current?.click()}>
              <Icon name="upload" /> choose ZIP
            </button>
          </div>
        )}
        {state.status === 'error' ? (
          <p className="import-card__error" role="alert">
            {state.message}
          </p>
        ) : null}
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void start({ request: () => Promise.resolve({ kind: 'zip', file }) });
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          {...{ webkitdirectory: '' }}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length > 0) void start({ request: () => Promise.resolve(requestFromFileList(files)) });
          }}
        />
      </div>
    </article>
  );
}

/** Time left, only when there is enough to measure. */
function eta(p: ImportProgress, startedAt: number): string {
  const elapsed = performance.now() - startedAt;
  if (elapsed < 2000 || p.bytes < 1024 ** 2 || p.totalBytes <= p.bytes) return `${Math.round(elapsed / 1000)} s`;
  return `about ${Math.max(1, Math.round(((p.totalBytes - p.bytes) * elapsed) / p.bytes / 1000))} s left`;
}
