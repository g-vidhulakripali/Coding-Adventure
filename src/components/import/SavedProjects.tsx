import { useCallback, useEffect, useState } from 'react';
import { listProjects, removeProject, type SavedProject } from '../../core/project/storage';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';

/** Projects kept in this browser: open again without importing, or remove. */
export function SavedProjects({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [projects, setProjects] = useState<readonly SavedProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Project waiting for a second click before it is removed. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listProjects().then(setProjects, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(refresh, [refresh]);

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    removeProject(id).then(refresh, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

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
        ) : projects === null ? (
          <p>…</p>
        ) : projects.length === 0 ? (
          <p>
            <span className="tok tok--c"># </span>
            Nothing saved yet. Imported projects appear here.
          </p>
        ) : (
          <ul className="saved-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className="saved-list__open" onClick={() => onOpen(p.id)} title={`Open ${p.name}`}>
                  <b>{p.name}</b>
                  <small>
                    {p.fileCount} files · {formatBytes(p.bytes)} · {new Date(p.savedAt).toLocaleDateString()}
                  </small>
                </button>
                <button type="button" className={confirming === p.id ? 'btn btn--danger' : 'btn btn--ghost'} onClick={() => remove(p.id)} onBlur={() => setConfirming(null)} aria-label={`Remove ${p.name} from this browser`}>
                  {confirming === p.id ? 'really remove?' : 'remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
