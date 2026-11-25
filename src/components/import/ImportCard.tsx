import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { canPickFolder, fromDrop, fromFileList, fromZip, pickFolder, type ImportSource } from '../../core/import/sources';
import { importProject, type ImportProgress } from '../../core/project/storage';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';
import './ImportCard.css';

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'reading' }
  | { readonly status: 'saving'; readonly name: string; readonly progress: ImportProgress | null }
  | { readonly status: 'error'; readonly message: string };

/** Choose or drop a folder or ZIP. Everything is checked and saved in this browser only. */
export function ImportCard({ onImported }: { onImported: (projectId: string) => void }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [over, setOver] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = state.status === 'reading' || state.status === 'saving';

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (getSource: () => Promise<ImportSource | null>) => {
      const controller = new AbortController();
      abort.current = controller;
      setState({ status: 'reading' });
      try {
        const source = await getSource();
        if (!source || controller.signal.aborted) {
          setState({ status: 'idle' });
          return;
        }
        setState({ status: 'saving', name: source.name, progress: null });
        let shown = 0;
        const id = await importProject(
          source,
          (progress) => {
            const now = performance.now();
            if (now - shown < 80 && progress.done < progress.total) return;
            shown = now;
            setState({ status: 'saving', name: source.name, progress });
          },
          controller.signal,
        );
        onImported(id);
      } catch (err) {
        if (controller.signal.aborted) setState({ status: 'idle' });
        else setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [onImported],
  );

  const chooseFolder = () => {
    if (canPickFolder()) void run(pickFolder);
    else folderInput.current?.click();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (busy) return;
    const source = fromDrop(e.dataTransfer);
    void run(() => source);
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
          Choose a folder or a ZIP, or drop it here. It stays in this browser and is never run.
        </p>
        {busy ? (
          <div className="import-card__progress" role="status" aria-live="polite">
            <span className="import-card__what">
              {state.status === 'reading' ? 'looking at the files…' : p ? `${p.done}/${p.total} files · ${formatBytes(p.bytes)}` : 'checking…'}
            </span>
            <progress max={p?.total ?? 1} value={p?.done ?? undefined} aria-label="Import progress" />
            <span className="import-card__path">{p?.path ?? ''}</span>
            <button type="button" className="btn btn--ghost" onClick={() => abort.current?.abort()}>
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
            if (file) void run(() => fromZip(file));
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
            if (files.length > 0) void run(() => Promise.resolve(fromFileList(files)));
          }}
        />
      </div>
    </article>
  );
}
