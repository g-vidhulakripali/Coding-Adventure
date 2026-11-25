import { Icon } from '../../components/common/Icon';
import { useCallback, useState } from 'react';
import { ImportCard, type ImportJob } from '../../components/import/ImportCard';
import { SavedProjects } from '../../components/import/SavedProjects';
import { AppHeader } from '../../components/layout/AppHeader';
import type { ThemePreference } from '../../hooks/useTheme';
import { SAMPLE_PROJECT_ID } from '../../demo/constants';
import { navigate } from '../router';
import './HomeRoute.css';

export interface HomeRouteProps {
  readonly theme: ThemePreference;
  readonly onThemeChange: (theme: ThemePreference) => void;
}

/** Decorative hero "source file". Plain text shown in an editor frame — not analysed, not executed. */
const HERO_LINES: ReadonlyArray<ReadonlyArray<[string, string]>> = [
  [['c', '# Understand unfamiliar code']],
  [['c', '# by playing with it.']],
  [],
  [['k', 'def '], ['f', 'explore'], ['p', '('], ['v', 'repo'], ['p', '):']],
  [['i', '    '], ['k', 'for '], ['v', 'step '], ['k', 'in '], ['v', 'repo'], ['p', '.'], ['f', 'operations'], ['p', '():']],
  [['i', '        '], ['f', 'watch'], ['p', '('], ['v', 'step'], ['p', '.'], ['v', 'values'], ['p', ')'], ['c', '      # see data move']],
  [['i', '        '], ['f', 'verify'], ['p', '('], ['v', 'step'], ['p', '.'], ['v', 'source'], ['p', ')'], ['c', '      # exact line, always']],
];

const openProject = (projectId: string) => navigate({ name: 'workspace', projectId, file: null, lines: null });

export function HomeRoute({ theme, onThemeChange }: HomeRouteProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);
  const imported = useCallback(
    (ids: readonly string[]) => {
      refresh();
      // A backup of several projects stays on this page, where they all appear.
      if (ids.length === 1) openProject(ids[0]!);
    },
    [refresh],
  );
  return (
    <div className="home">
      <AppHeader theme={theme} onThemeChange={onThemeChange} />
      <main className="home__main">
        <section className="home__hero">
          <h1 className="visually-hidden">Code Playground: understand unfamiliar code by playing with it</h1>
          <div className="editor-frame" aria-hidden="true">
            <div className="editor-frame__bar">
              <span className="editor-frame__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="editor-frame__tab">playground.py</span>
            </div>
            <pre className="editor-frame__code">
              {HERO_LINES.map((tokens, i) => (
                <span key={i} className="editor-frame__line">
                  <span className="editor-frame__ln">{i + 1}</span>
                  <span>
                    {tokens.map(([kind, text], j) => (
                      <span key={j} className={`tok tok--${kind}`}>
                        {text}
                      </span>
                    ))}
                    {i === HERO_LINES.length - 1 ? <span className="editor-frame__cursor" /> : null}
                  </span>
                </span>
              ))}
            </pre>
          </div>

          <p className="home__lede">
            Open a repository, follow values through each operation, and check every explanation against the original source.
          </p>

          <ul className="terminal" aria-label="Privacy guarantees">
            <li>
              <span className="terminal__prompt">$</span> code-playground --check
            </li>
            <li>
              <span className="terminal__ok">✓</span> runs entirely in your browser
            </li>
            <li>
              <span className="terminal__ok">✓</span> your code is never uploaded or executed
            </li>
            <li>
              <span className="terminal__ok">✓</span> no AI models: deterministic analysis only
            </li>
          </ul>
        </section>

        <section className="home__actions" aria-label="Get started">
          <ImportCard job={job} onImported={imported} onChanged={refresh} />
          <SavedProjects refreshKey={refreshKey} onOpen={openProject} onJob={setJob} />
          <article className="file-card file-card--active">
            <div className="file-card__tab">
              <span style={{ color: 'var(--lab-loop)' }}>
                <Icon name="play" />
              </span>
              sample_project.py
            </div>
            <div className="file-card__body">
              <h2>Explore the sample project</h2>
              <p>
                <span className="tok tok--c"># </span>A small Python repo: a discounted shopping total across two files, and a pandas indexing expression.
              </p>
              <button type="button" className="btn btn--primary" onClick={() => openProject(SAMPLE_PROJECT_ID)}>
                <span aria-hidden="true">&gt;</span> open sample
              </button>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
