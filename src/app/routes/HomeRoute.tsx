import { Icon } from '../../components/common/Icon';
import { AppHeader, BrandMark } from '../../components/layout/AppHeader';
import type { ThemePreference } from '../../hooks/useTheme';
import { SAMPLE_PROJECT_ID } from '../../demo/constants';
import { navigate } from '../router';
import './HomeRoute.css';

export interface HomeRouteProps {
  readonly theme: ThemePreference;
  readonly onThemeChange: (theme: ThemePreference) => void;
}

export function HomeRoute({ theme, onThemeChange }: HomeRouteProps) {
  return (
    <div className="home">
      <AppHeader theme={theme} onThemeChange={onThemeChange} />
      <main className="home__main">
        <section className="home__hero">
          <BrandMark size={56} />
          <h1>
            Understand unfamiliar code
            <br />
            <span className="home__hero-accent">by playing with it.</span>
          </h1>
          <p className="home__lede">
            Open a repository, follow values through each operation, and check every explanation against the original source.
          </p>
          <ul className="home__promises" aria-label="Privacy guarantees">
            <li>
              <Icon name="shield" /> Runs entirely in your browser
            </li>
            <li>
              <Icon name="shield" /> Your code is never uploaded or executed
            </li>
            <li>
              <Icon name="shield" /> No AI models — deterministic analysis only
            </li>
          </ul>
        </section>

        <section className="home__actions" aria-label="Get started">
          <article className="start-card start-card--primary">
            <span className="start-card__icon" style={{ color: 'var(--lab-function)' }}>
              <Icon name="play" />
            </span>
            <h2>Explore the sample project</h2>
            <p>A small Python repository: a discounted shopping total across two files, and a pandas indexing expression.</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate({ name: 'workspace', projectId: SAMPLE_PROJECT_ID, file: null, lines: null })}
            >
              Open sample <Icon name="chevronRight" />
            </button>
          </article>

          <article className="start-card" aria-disabled="true">
            <span className="start-card__icon" style={{ color: 'var(--lab-variable)' }}>
              <Icon name="upload" />
            </span>
            <h2>Import a ZIP repository</h2>
            <p>Secure, progressive import of your own repository, processed locally.</p>
            <span className="chip">Not available yet · Phase 4</span>
          </article>

          <article className="start-card" aria-disabled="true">
            <span className="start-card__icon" style={{ color: 'var(--lab-loop)' }}>
              <Icon name="library" />
            </span>
            <h2>Saved projects</h2>
            <p>Projects you prepare will be saved in this browser so you can reopen them without re-importing.</p>
            <span className="chip">Not available yet · Phase 6</span>
          </article>
        </section>
      </main>
    </div>
  );
}
