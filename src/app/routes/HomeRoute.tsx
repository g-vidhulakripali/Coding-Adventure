import { Icon, type IconName } from '../../components/common/Icon';
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

interface StartOption {
  readonly file: string;
  readonly icon: IconName;
  readonly colorVar: string;
  readonly title: string;
  readonly comment: string;
  readonly action?: { label: string; onClick: () => void };
  readonly status?: string;
}

const OPTIONS: readonly StartOption[] = [
  {
    file: 'sample_project.py',
    icon: 'play',
    colorVar: '--lab-loop',
    title: 'Explore the sample project',
    comment: 'A small Python repo: a discounted shopping total across two files, and a pandas indexing expression.',
    action: {
      label: 'open sample',
      onClick: () => navigate({ name: 'workspace', projectId: SAMPLE_PROJECT_ID, file: null, lines: null }),
    },
  },
  {
    file: 'import_zip.py',
    icon: 'upload',
    colorVar: '--lab-variable',
    title: 'Import a ZIP repository',
    comment: 'Secure, progressive import of your own repository, processed locally.',
    status: 'TODO: phase 4',
  },
  {
    file: 'saved_projects.db',
    icon: 'library',
    colorVar: '--lab-function',
    title: 'Saved projects',
    comment: 'Prepared projects are saved in this browser, so you can reopen them without re-importing.',
    status: 'TODO: phase 6',
  },
];

export function HomeRoute({ theme, onThemeChange }: HomeRouteProps) {
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
          {OPTIONS.map((option) => (
            <article key={option.file} className={option.action ? 'file-card file-card--active' : 'file-card'} aria-disabled={option.action ? undefined : true}>
              <div className="file-card__tab">
                <span style={{ color: `var(${option.colorVar})` }}>
                  <Icon name={option.icon} />
                </span>
                {option.file}
              </div>
              <div className="file-card__body">
                <h2>{option.title}</h2>
                <p>
                  <span className="tok tok--c"># </span>
                  {option.comment}
                </p>
                {option.action ? (
                  <button type="button" className="btn btn--primary" onClick={option.action.onClick}>
                    <span aria-hidden="true">&gt;</span> {option.action.label}
                  </button>
                ) : (
                  <span className="chip">{option.status}</span>
                )}
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
