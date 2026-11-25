import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CodePanel, type FileContentState } from '../../components/code-editor/CodePanel';
import { Icon } from '../../components/common/Icon';
import { ExplanationPanel, ExplanationRail } from '../../components/explanation/ExplanationPanel';
import { ExplorerSidebar } from '../../components/file-explorer/ExplorerSidebar';
import { AppHeader } from '../../components/layout/AppHeader';
import { LayoutModeSwitcher } from '../../components/layout/LayoutModeSwitcher';
import {
  DEFAULT_LAYOUT_MODE,
  LAYOUT_MODES,
  isLayoutMode,
  layoutModeInfo,
  type CompactPanel,
  type LayoutMode,
} from '../../components/layout/layoutModes';
import { ResizableRow, type RowPanel } from '../../components/layout/ResizableRow';
import { VisualLabPanel } from '../../components/visual-lab/VisualLabPanel';
import { useSimulationController } from '../../components/visual-lab/useSimulationController';
import type { ViewerHighlight } from '../../components/code-editor/codemirrorSetup';
import { extractPythonOutline, type FileOutline, type OutlineSymbol } from '../../core/parser/outline';
import { defaultFileFor, loadProject } from '../../core/project/registry';
import { isTextCategory } from '../../core/repository/fileTypes';
import type { ProjectSource } from '../../core/repository/types';
import type { LineRange } from '../../core/source-mapping/types';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { usePreference } from '../../hooks/usePreference';
import type { ThemePreference } from '../../hooks/useTheme';
import { navigate } from '../router';
import './WorkspaceRoute.css';

type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; project: ProjectSource }
  | { status: 'missing' }
  | { status: 'error'; message: string };

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

export interface WorkspaceRouteProps {
  readonly projectId: string;
  readonly filePath: string | null;
  readonly lines: LineRange | null;
  readonly theme: ThemePreference;
  readonly onThemeChange: (theme: ThemePreference) => void;
}

export function WorkspaceRoute({ projectId, filePath, lines, theme, onThemeChange }: WorkspaceRouteProps) {
  const [projectState, setProjectState] = useState<ProjectState>({ status: 'loading' });
  // Content is tagged with its path so a file switch never shows the previous file's text under the new name.
  const [loaded, setLoaded] = useState<{ path: string; state: FileContentState } | null>(null);
  const [layoutMode, setLayoutMode] = usePreference<LayoutMode>('layout-mode', DEFAULT_LAYOUT_MODE, isLayoutMode);
  const [explorerOpen, setExplorerOpen] = usePreference<boolean>('explorer-open', true, isBoolean);
  const [explainCollapsed, setExplainCollapsed] = usePreference<boolean>('explain-collapsed', false, isBoolean);
  const [compactPanel, setCompactPanel] = useState<CompactPanel>('code');
  const compact = useMediaQuery('(max-width: 899px)');

  // ---- Load project ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setProjectState({ status: 'loading' });
    loadProject(projectId).then(
      (project) => !cancelled && setProjectState(project ? { status: 'ready', project } : { status: 'missing' }),
      (err: unknown) => !cancelled && setProjectState({ status: 'error', message: String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const project = projectState.status === 'ready' ? projectState.project : null;
  const file = useMemo(() => (project && filePath ? (project.files.find((f) => f.path === filePath) ?? null) : null), [project, filePath]);

  // ---- No file in the URL → open a sensible default ----------------------
  useEffect(() => {
    if (!project || filePath) return;
    const fallback = defaultFileFor(project);
    if (fallback) navigate({ name: 'workspace', projectId, file: fallback, lines: null }, { replace: true });
  }, [project, filePath, projectId]);

  // ---- Load file text -----------------------------------------------------
  useEffect(() => {
    if (!project || !filePath) return;
    if (!file) {
      setLoaded({ path: filePath, state: { status: 'error', message: `This project has no file at “${filePath}”.` } });
      return;
    }
    if (!isTextCategory(file.category)) {
      setLoaded({ path: filePath, state: { status: 'idle' } });
      return;
    }
    let cancelled = false;
    project.readText(file.path).then(
      (text) => !cancelled && setLoaded({ path: file.path, state: { status: 'ready', text } }),
      (err: unknown) =>
        !cancelled &&
        setLoaded({ path: file.path, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [project, file, filePath]);

  const content: FileContentState = !filePath
    ? { status: 'idle' }
    : loaded && loaded.path === filePath
      ? loaded.state
      : { status: 'loading' };

  const outline: FileOutline | null = useMemo(
    () => (file?.category === 'python' && content.status === 'ready' ? extractPythonOutline(content.text) : null),
    [file, content],
  );
  const lineCount = content.status === 'ready' ? countLines(content.text) : null;

  // ---- Python sources for simulation and the call map ----------------------
  const [sources, setSources] = useState<Map<string, string> | null>(null);
  // CSV files the code may read with pd.read_csv (data only; nothing is executed).
  const [dataFiles, setDataFiles] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const read = (category: string) =>
      Promise.all(project.files.filter((f) => f.category === category).map((f) => project.readText(f.path).then((text) => [f.path, text] as const)));
    Promise.all([read('python'), read('csv')]).then(
      ([py, csv]) => {
        if (cancelled) return;
        setSources(new Map(py));
        setDataFiles(new Map(csv));
      },
      () => !cancelled && setSources(new Map()),
    );
    return () => {
      cancelled = true;
    };
  }, [project]);
  const sim = useSimulationController(sources, dataFiles, filePath);

  // ---- Navigation helpers ------------------------------------------------
  const go = useCallback(
    (path: string | null, range: LineRange | null, replace = false) =>
      navigate({ name: 'workspace', projectId, file: path, lines: range }, { replace }),
    [projectId],
  );
  const selectFile = useCallback(
    (path: string) => {
      go(path, null);
      if (compact) setCompactPanel('code');
    },
    [go, compact],
  );
  const selectSymbol = useCallback(
    (symbol: OutlineSymbol) => {
      go(filePath, symbol.range);
      if (compact) setCompactPanel('code');
    },
    [go, filePath, compact],
  );
  const selectLine = useCallback((line: number) => go(filePath, { startLine: line, endLine: line }, true), [go, filePath]);
  // ---- Source highlight: user selection (route) or the simulation step ----
  // The simulation takes over the highlight only after the user steps through it,
  // and follows execution into other files.
  const [highlightMode, setHighlightMode] = useState<'route' | 'sim'>('route');
  useEffect(() => {
    if (sim.navigationSerial === 0 || !sim.step) return;
    setHighlightMode('sim');
    if (sim.step.span.path !== filePath) go(sim.step.span.path, null, true);
  }, [sim.navigationSerial]);
  const linesKey = lines ? `${lines.startLine}-${lines.endLine}` : '';
  useEffect(() => {
    if (lines) setHighlightMode('route');
  }, [linesKey]);
  const simSpan = highlightMode === 'sim' && sim.step && sim.step.span.path === filePath ? sim.step.span : null;
  const codeHighlight: ViewerHighlight | null = simSpan
    ? { startLine: simSpan.startLine, endLine: simSpan.endLine, startColumn: simSpan.startColumn, endColumn: simSpan.endColumn }
    : highlightMode === 'route'
      ? lines
      : null;
  const clearHighlight = useCallback(() => {
    setHighlightMode('route');
    go(filePath, null, true);
  }, [go, filePath]);

  // ---- Keyboard shortcuts: Alt+1..4 switch layout ------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const mode = LAYOUT_MODES.find((m) => m.shortcut === e.key);
      if (mode) {
        e.preventDefault();
        setLayoutMode(mode.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLayoutMode]);

  // ---- Non-ready project states -------------------------------------------
  const header = (
    <AppHeader
      theme={theme}
      onThemeChange={onThemeChange}
      center={
        project ? (
          <span className="workspace__project">
            <span className="workspace__project-name">{project.name}</span>
            {project.origin === 'demo' ? (
              <span className="chip" title="Bundled demonstration project — not an uploaded repository">
                demo
              </span>
            ) : null}
          </span>
        ) : null
      }
      controls={
        project && !compact ? (
          <>
            <button
              type="button"
              className="btn btn--icon btn--ghost"
              aria-pressed={explorerOpen}
              onClick={() => setExplorerOpen((v) => !v)}
              title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
              aria-label="Toggle file explorer"
            >
              <Icon name="sidebar" />
            </button>
            <LayoutModeSwitcher mode={layoutMode} onChange={setLayoutMode} />
          </>
        ) : null
      }
    />
  );

  if (!project) {
    return (
      <div className="workspace">
        {header}
        <div className="workspace__status">
          {projectState.status === 'loading' ? (
            <p>Opening project…</p>
          ) : (
            <>
              <h2>{projectState.status === 'missing' ? 'Project not found' : 'Could not open project'}</h2>
              <p>
                {projectState.status === 'missing'
                  ? `There is no project with id “${projectId}” in this browser.`
                  : projectState.status === 'error'
                    ? projectState.message
                    : null}
              </p>
              <button type="button" className="btn btn--primary" onClick={() => navigate({ name: 'home' })}>
                <Icon name="home" /> Back to start
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ---- Panels ---------------------------------------------------------------
  const explorer = (
    <ExplorerSidebar
      projectName={project.name}
      files={project.files}
      selectedPath={filePath}
      onSelectFile={selectFile}
      outline={outline ? outline.symbols : null}
      activeLines={lines}
      onSelectSymbol={selectSymbol}
    />
  );
  const code = <CodePanel file={file} content={content} highlight={codeHighlight} onLineClick={selectLine} onClearHighlight={clearHighlight} />;
  const lab = (
    <VisualLabPanel
      sim={sim}
      currentFile={filePath}
      onNavigate={(path, range) => {
        go(path, range);
        if (compact) setCompactPanel('code');
      }}
    />
  );
  const explanation = (
    <ExplanationPanel
      file={file}
      lineCount={lineCount}
      outline={outline}
      sim={sim}
      onCollapse={compact ? undefined : () => setExplainCollapsed(true)}
    />
  );

  if (compact) {
    const tabs: Array<{ id: CompactPanel; label: string }> = [
      { id: 'files', label: 'Files' },
      { id: 'code', label: 'Code' },
      { id: 'lab', label: 'Lab' },
      { id: 'explain', label: 'Explain' },
    ];
    const panels: Record<CompactPanel, ReactNode> = { files: explorer, code, lab, explain: explanation };
    return (
      <div className="workspace workspace--compact">
        {header}
        <nav className="compact-tabs" aria-label="Workspace panels">
          {tabs.map((t) => (
            <button key={t.id} type="button" className="compact-tabs__tab" aria-pressed={compactPanel === t.id} onClick={() => setCompactPanel(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <main className="workspace__body workspace__body--compact">{panels[compactPanel]}</main>
      </div>
    );
  }

  const mode = layoutModeInfo(layoutMode);
  const rowPanels: RowPanel[] = [];
  if (explorerOpen) rowPanels.push({ id: 'explorer', label: 'file explorer', content: explorer, defaultWeight: 0.17, minPx: 180 });
  if (mode.showCode) rowPanels.push({ id: 'code', label: 'source', content: code, defaultWeight: 0.36, minPx: 260 });
  if (mode.showLab) rowPanels.push({ id: 'lab', label: 'visual lab', content: lab, defaultWeight: 0.3, minPx: 260 });
  if (mode.showExplanation) {
    rowPanels.push(
      explainCollapsed
        ? { id: 'explain-rail', label: 'explanation', content: <ExplanationRail onExpand={() => setExplainCollapsed(false)} />, fixedPx: 40 }
        : { id: 'explain', label: 'explanation', content: explanation, defaultWeight: 0.2, minPx: 220 },
    );
  }

  return (
    <div className="workspace">
      {header}
      <main className="workspace__body">
        <ResizableRow panels={rowPanels} storageKey="panel-weights" />
      </main>
    </div>
  );
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  // A trailing newline terminates the last line rather than starting a new one.
  return text.endsWith('\n') ? lines - 1 : lines;
}
