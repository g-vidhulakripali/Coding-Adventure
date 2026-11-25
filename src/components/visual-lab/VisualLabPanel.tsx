import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { LineRange } from '../../core/source-mapping/types';
import { buildScene } from '../../core/visualisation/scene';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { usePreference } from '../../hooks/usePreference';
import { Icon } from '../common/Icon';
import { Panel } from '../layout/Panel';
import { CallMap } from './CallMap';
import { InputsPanel, PlaybackControls } from './LabControls';
import { Stage2D } from './Stage2D';
import { StepCard } from './StepCard';
import { STEP_INTERVAL_MS, type SimulationController } from './useSimulationController';
import { VisualVocabulary } from './VisualVocabulary';
import { webglAvailable } from './webgl';
import './VisualLabPanel.css';

// Three.js is only downloaded when the 3D view is actually shown.
const Stage3D = lazy(() => import('./Stage3D'));

const NO_SOURCES: ReadonlyMap<string, string> = new Map();

type LabMode = 'simulation' | 'callmap';
type DockTab = 'step' | 'inputs';
type ViewMode = '3d' | '2d';

const isLabMode = (v: unknown): v is LabMode => v === 'simulation' || v === 'callmap';
const isViewMode = (v: unknown): v is ViewMode => v === '3d' || v === '2d';
const isDockTab = (v: unknown): v is DockTab => v === 'step' || v === 'inputs';
type DockChoice = 'auto' | 'open' | 'closed';
const isDockChoice = (v: unknown): v is DockChoice => v === 'auto' || v === 'open' || v === 'closed';

/** Below this Lab height the dock starts collapsed, leaving room for the story and the scene. */
const DOCK_AUTO_OPEN_HEIGHT = 720;
/**
 * Below this Lab height a 3D scene cannot be read (labels collide), so the
 * story-first 2D view is used. Based on the panel height, which only changes
 * on resize, so the view never flips between steps.
 */
const MIN_3D_LAB_HEIGHT = 560;

function useElementHeight<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    observer.observe(el);
    setHeight(el.getBoundingClientRect().height);
    return () => observer.disconnect();
  });
  return [ref, height];
}

export interface VisualLabPanelProps {
  readonly sim: SimulationController;
  readonly currentFile: string | null;
  readonly onNavigate: (path: string, lines: LineRange | null) => void;
}

export function VisualLabPanel({ sim, currentFile, onNavigate }: VisualLabPanelProps) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const canWebGL = useMemo(() => webglAvailable(), []);
  const [labMode, setLabMode] = usePreference<LabMode>('lab-mode', 'simulation', isLabMode);
  // 3D by default; 2D when WebGL is missing or the user prefers reduced motion (switchable).
  // The line-by-line view is the default; the 3D bench is one click away.
  const [viewPref, setViewPref] = usePreference<ViewMode>('lab-view-v2', '2d', isViewMode);
  const [webglError, setWebglError] = useState<string | null>(canWebGL ? null : 'WebGL is not available in this browser.');
  const wants3D = viewPref === '3d' && !webglError;
  const [resetSignal, setResetSignal] = useState(0);
  const [dockPref, setDockTab] = usePreference<DockTab>('lab-dock', 'step', isDockTab);
  const [dockChoice, setDockChoice] = usePreference<DockChoice>('lab-dock-open', 'auto', isDockChoice);
  const [labRef, labHeight] = useElementHeight<HTMLDivElement>();
  const inputCount = sim.inputFields.length + sim.params.length + (sim.missingData ? 1 : 0);
  // A function still waiting for arguments always shows its inputs; with no inputs there is only the step tab.
  const needsInput = sim.missingData !== null && !sim.missingData.supplied;
  const open = sim.missingParams.length;
  const dockTab: DockTab = needsInput ? 'inputs' : inputCount === 0 ? 'step' : dockPref;
  const editedCount = sim.inputFields.filter((f) => f.edited).length;
  const dockOpen = needsInput || dockChoice === 'open' || (dockChoice === 'auto' && labHeight >= DOCK_AUTO_OPEN_HEIGHT);
  const selectDockTab = (tab: DockTab) => {
    if (dockOpen && dockTab === tab) setDockChoice('closed');
    else {
      setDockTab(tab);
      setDockChoice('open');
    }
  };
  const tooShortFor3D = labHeight > 0 && labHeight < MIN_3D_LAB_HEIGHT;
  const view: ViewMode = wants3D && !tooShortFor3D ? '3d' : '2d';

  const scene = useMemo(() => (sim.trace ? buildScene(sim.trace, sim.stepIndex) : null), [sim.trace, sim.stepIndex]);

  const assumed = useMemo(() => new Set(sim.trace?.steps.flatMap((s) => (s.assumption ? [s.assumption.key] : s.title === 'One example item' ? [`${s.span.path}:${s.span.startLine}`] : []))).size, [sim.trace]);

  // Animate only single forward steps; jumps and backwards moves snap.
  const prevIndex = useRef(sim.stepIndex);
  const prevTrace = useRef(sim.trace);
  const forward = sim.stepIndex === prevIndex.current + 1 && prevTrace.current === sim.trace;
  useEffect(() => {
    prevIndex.current = sim.stepIndex;
    prevTrace.current = sim.trace;
  });
  const durationMs = forward && !reducedMotion ? (STEP_INTERVAL_MS * 0.6) / sim.speed : 0;

  // Keyboard: ← → step, space play/pause (ignored while typing or inside the code editor).
  useEffect(() => {
    if (labMode !== 'simulation') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('input, textarea, select, [contenteditable="true"], .cm-editor') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') sim.next();
      else if (e.key === 'ArrowLeft') sim.prev();
      else if (e.key === 'ArrowDown' && !t.closest('.lab__dock-body')) sim.stepOver();
      else if (e.key === ' ' && !t.closest('button')) sim.togglePlay();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [labMode, sim]);

  const actions = (
    <>
      <div className="seg" role="tablist" aria-label="Lab view">
        <button type="button" role="tab" aria-selected={labMode === 'simulation'} onClick={() => setLabMode('simulation')}>
          simulation
        </button>
        <button type="button" role="tab" aria-selected={labMode === 'callmap'} onClick={() => setLabMode('callmap')}>
          call map
        </button>
      </div>
      {labMode === 'simulation' ? (
        <>
          <div className="seg" role="radiogroup" aria-label="Rendering">
            <button type="button" role="radio" aria-checked={!wants3D} onClick={() => setViewPref('2d')} title="Line-by-line view">
              lines
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={wants3D}
              disabled={!!webglError}
              title={webglError ?? '3D bench'}
              onClick={() => setViewPref('3d')}
            >
              3D
            </button>
          </div>
          {view === '3d' ? (
            <button type="button" className="btn btn--icon btn--ghost" onClick={() => setResetSignal((n) => n + 1)} title="Reset camera" aria-label="Reset camera">
              <Icon name="home" />
            </button>
          ) : null}
        </>
      ) : null}
    </>
  );

  return (
    <Panel title="Visual Lab" icon="flask" accentVar="--lab-function" actions={actions} className="lab-panel">
      {labMode === 'callmap' ? (
        sim.callIndex ? (
          <CallMap index={sim.callIndex} currentFile={currentFile} onNavigate={(path, lines) => onNavigate(path, lines)} />
        ) : (
          <p className="lab-message">Analysing Python files…</p>
        )
      ) : (
        <div className="lab" ref={labRef}>
          <div className="lab__bar">
            {sim.scenarios.length > 0 ? (
              <select className="lab__scenario" value={sim.scenario?.id ?? ''} onChange={(e) => sim.selectScenario(e.target.value)} aria-label="What to simulate">
                {!sim.scenario ? <option value="">Choose what to run…</option> : null}
                {sim.scenario && !sim.scenarios.some((s) => s.id === sim.scenario!.id) ? <option value={sim.scenario.id}>{sim.scenario.label}</option> : null}
                <optgroup label={currentFile?.split('/').pop() ?? 'This file'}>
                  {sim.scenarios
                    .filter((s) => s.path === currentFile)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                </optgroup>
                {sim.scenarios.some((s) => s.path !== currentFile) ? (
                  <optgroup label="Other files">
                    {sim.scenarios
                      .filter((s) => s.path !== currentFile)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                  </optgroup>
                ) : null}
              </select>
            ) : null}
            {sim.suggestedScenario ? (
              <button type="button" className="btn btn--ghost lab__suggest" onClick={() => sim.selectScenario(sim.suggestedScenario!.id)} title={sim.suggestedScenario.label}>
                ▶{' '}
                {sim.suggestedScenario.kind === 'script'
                  ? 'run this file'
                  : sim.suggestedScenario.kind === 'method'
                    ? `try ${sim.suggestedScenario.className}.${sim.suggestedScenario.method}`
                    : `try ${sim.suggestedScenario.name}()`}
              </button>
            ) : null}
            {sim.trace ? (
              <span className={`chip lab__status is-${sim.trace.status}`} title={sim.trace.stop?.message ?? 'The simulation ran to the end.'}>
                {sim.trace.status === 'completed' ? (sim.trace.steps.some((s) => s.output?.t === 'unknown') ? '✓ to the end, some ?' : '✓ ran to the end') : sim.trace.stop?.kind === 'error' ? (sim.trace.steps[sim.trace.steps.length - 1]?.evidence === 'inferred' ? '✗ maybe an error' : '✗ raises an error') : sim.trace.stop?.kind === 'limit' ? '■ stopped at limit' : sim.trace.stop?.kind === 'missing-data' ? '📄 needs data' : '■ stops: unsupported'}
              </span>
            ) : null}
            {assumed > 0 ? (
              <span className="chip lab__assumed" title="Answers that are not known were assumed on the way. They are listed under “About this run”, and you can switch them on their line.">
                {assumed} assumed
              </span>
            ) : null}
          </div>

          <div className="lab__stage">
            {!sim.ready ? (
              <p className="lab-message">Reading Python files…</p>
            ) : !sim.scenario ? (
              <div className="lab-empty">
                <p className="lab-message">Nothing in this project can be simulated yet. Open a Python file with top-level code or a function.</p>
                <VisualVocabulary />
              </div>
            ) : scene && sim.trace && sim.step ? (
              view === '3d' ? (
                <Suspense fallback={<p className="lab-message">Loading 3D laboratory…</p>}>
                  <Stage3D scene={scene} durationMs={durationMs} resetSignal={resetSignal} onUnavailable={(reason) => setWebglError(reason)} />
                </Suspense>
              ) : (
                <Stage2D scene={scene} trace={sim.trace} stepIndex={sim.stepIndex} sources={sim.sources ?? NO_SOURCES} durationMs={durationMs} onChoose={sim.choose} />
              )
            ) : (
              <p className="lab-message">No steps recorded.</p>
            )}
            {webglError && viewPref === '3d' ? <p className="lab__notice">3D unavailable ({webglError}). Showing the 2D view.</p> : null}
            {wants3D && tooShortFor3D && sim.trace ? (
              <p className="lab__notice">Lines view: 3D needs a taller window (or the “Lab only” layout).</p>
            ) : null}
          </div>

          {/* Step facts and inputs share one docked area, so nothing is pushed below the fold. */}
          {sim.scenario ? (
            <section className={`lab__dock${dockOpen ? '' : ' is-closed'}`}>
              <div className="lab__dock-tabs" role="tablist" aria-label="Step details and inputs">
                <button type="button" role="tab" aria-selected={dockOpen && dockTab === 'step'} onClick={() => selectDockTab('step')} disabled={!sim.step}>
                  step{sim.trace && sim.step ? ` ${sim.stepIndex + 1}/${sim.trace.steps.length}` : ''}
                </button>
                {inputCount > 0 ? (
                  <button type="button" role="tab" aria-selected={dockOpen && dockTab === 'inputs'} onClick={() => selectDockTab('inputs')}>
                    inputs <span className="lab__dock-count">{inputCount}</span>
                    {open > 0 ? (
                      <span className="lab__dock-open" title={`${open} without a value: they show as ?`}>
                        {open} ×?
                      </span>
                    ) : null}
                    {editedCount > 0 ? (
                      <span className="lab__dock-edited" title={`${editedCount} edited`}>
                        •
                      </span>
                    ) : null}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="lab__dock-toggle"
                  onClick={() => setDockChoice(dockOpen ? 'closed' : 'open')}
                  aria-expanded={dockOpen}
                  title={dockOpen ? 'Hide details (more room for the picture)' : 'Show details'}
                >
                  {dockOpen ? '▾ hide' : '▴ show'}
                </button>
              </div>
              {dockOpen ? (
              <div className="lab__dock-body" role="tabpanel">
                {dockTab === 'inputs' ? (
                  <InputsPanel sim={sim} />
                ) : scene && sim.trace && sim.step ? (
                  <StepCard trace={sim.trace} step={sim.step} scene={scene} onJump={sim.goTo} />
                ) : null}
              </div>
              ) : null}
            </section>
          ) : null}
          <PlaybackControls sim={sim} />
        </div>
      )}
    </Panel>
  );
}
