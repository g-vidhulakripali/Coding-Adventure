import { useCallback, useEffect, useState } from 'react';
import { exportProjects } from '../../core/project/backup';
import { askToKeep, listProjects, removeProject, reopenRequest, storageOverview, type SavedProject, type StorageOverview } from '../../core/project/storage';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';
import type { ImportJob } from './ImportCard';

/** Projects kept in this browser: open, finish, back up or remove them, and see the space they use. */
export function SavedProjects({ refreshKey, onOpen, onJob }: { refreshKey: number; onOpen: (projectId: string) => void; onJob: (job: ImportJob) => void }) {
  const [projects, setProjects] = useState<readonly SavedProject[] | null>(null);
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  /** Project waiting for a second click before it is removed. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const fail = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), []);

  const refresh = useCallback(() => {
    listProjects().then((list) => {
      setProjects(list);
      setError(null);
    }, fail);
    void storageOverview().then(setOverview);
  }, [fail]);
  useEffect(refresh, [refresh, refreshKey]);

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    removeProject(id).then(refresh, fail);
  };
  const backUp = (ids: readonly string[], name: string) => {
    setExporting('0 %');
    exportProjects(ids, (done, total) => setExporting(`${Math.round((100 * done) / Math.max(1, total))} %`))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.replace(/[^\w.-]+/g, '-')}.codeplayground.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(fail)
      .finally(() => setExporting(null));
  };

  const complete = (projects ?? []).filter((p) => !p.unfinished);
  return (
    <article className="file-card file-card--active">
      <div className="file-card__tab">
        <span style={{ color: 'var(--lab-function)' }}>
          <Icon name="library" />
        </span>
        saved_projects.db
      </div>
      <div className="file-card__body">
        <h2>Saved projects</h2>
        {error ? (
          <p className="import-card__error" role="alert">
            {error}
          </p>
        ) : null}
        {projects === null ? (
          error ? null : <p>…</p>
        ) : projects.length === 0 ? (
          <p>
            <span className="tok tok--c"># </span>
            Nothing saved yet. Imported projects appear here.
          </p>
        ) : (
          <ul className="saved-list">
            {projects.map((p) => (
              <li key={p.id}>
                {p.unfinished ? (
                  <button
                    type="button"
                    className="saved-list__open is-unfinished"
                    disabled={!p.unfinished.resumable}
                    onClick={() => onJob({ request: () => reopenRequest(p.id), resume: p.id })}
                    title={p.unfinished.resumable ? 'Continue the import where it stopped' : 'What it was imported from is gone. Remove it and import it again.'}
                  >
                    <b>{p.name}</b>
                    <small>
                      stopped at {p.unfinished.done} of {p.unfinished.total} files{p.unfinished.resumable ? ' · click to continue' : ''}
                    </small>
                  </button>
                ) : (
                  <button type="button" className="saved-list__open" onClick={() => onOpen(p.id)} title={`Open ${p.name}`}>
                    <b>{p.name}</b>
                    <small>
                      {p.fileCount} files · {formatBytes(p.bytes)} · {new Date(p.savedAt).toLocaleDateString()}
                    </small>
                  </button>
                )}
                <span className="saved-list__tools">
                  {p.unfinished ? null : (
                    <button type="button" className="btn btn--ghost" disabled={exporting !== null} onClick={() => backUp([p.id], p.name)} aria-label={`Save a backup of ${p.name}`}>
                      backup
                    </button>
                  )}
                  <button type="button" className={confirming === p.id ? 'btn btn--danger' : 'btn btn--ghost'} onClick={() => remove(p.id)} onBlur={() => setConfirming(null)} aria-label={`Remove ${p.name} from this browser`}>
                    {confirming === p.id ? 'really remove?' : 'remove'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="storage-line">
          {overview?.usage !== null && overview?.usage !== undefined && overview.quota ? (
            <>
              <meter min={0} max={overview.quota} value={overview.usage} aria-label="Browser storage used" />
              <small>
                {formatBytes(overview.usage)} used of about {formatBytes(overview.quota)}
              </small>
            </>
          ) : (
            <small>This browser does not say how much space is left.</small>
          )}
          {overview?.kept === false && complete.length > 0 ? (
            <button type="button" className="btn btn--ghost" onClick={() => void askToKeep().then(refresh)} title="Without this, the browser may delete saved projects when the disk gets full">
              ask the browser to keep them
            </button>
          ) : overview?.kept ? (
            <small title="The browser promised not to delete saved projects by itself">✓ kept</small>
          ) : null}
          {complete.length > 1 ? (
            <button type="button" className="btn btn--ghost" disabled={exporting !== null} onClick={() => backUp(complete.map((p) => p.id), 'all-projects')}>
              back up all
            </button>
          ) : null}
          {exporting ? <small role="status">writing backup… {exporting}</small> : null}
        </div>
      </div>
    </article>
  );
}
