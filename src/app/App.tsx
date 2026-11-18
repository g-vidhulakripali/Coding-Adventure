import { lazy, Suspense } from 'react';
import { useTheme } from '../hooks/useTheme';
import { AppHeader } from '../components/layout/AppHeader';
import { HomeRoute } from './routes/HomeRoute';
import { navigate, useRoute } from './router';

// The workspace pulls in CodeMirror and the Python grammar; load it only when a project is opened.
const WorkspaceRoute = lazy(() => import('./routes/WorkspaceRoute').then((m) => ({ default: m.WorkspaceRoute })));

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();

  switch (route.name) {
    case 'home':
      return <HomeRoute theme={theme} onThemeChange={setTheme} />;
    case 'workspace':
      return (
        <Suspense fallback={<div className="workspace__status">Opening workspace…</div>}>
          <WorkspaceRoute
            key={route.projectId}
            projectId={route.projectId}
            filePath={route.file}
            lines={route.lines}
            theme={theme}
            onThemeChange={setTheme}
          />
        </Suspense>
      );
    case 'not-found':
      return (
        <div className="workspace">
          <AppHeader theme={theme} onThemeChange={setTheme} />
          <div className="workspace__status">
            <h2>Page not found</h2>
            <p>Nothing lives at “{route.path}”.</p>
            <button type="button" className="btn btn--primary" onClick={() => navigate({ name: 'home' })}>
              Back to start
            </button>
          </div>
        </div>
      );
  }
}
