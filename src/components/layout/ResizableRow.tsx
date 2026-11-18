import { Fragment, useCallback, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { usePreference } from '../../hooks/usePreference';
import { resizePair, type PairState } from './resize';
import './ResizableRow.css';

export interface RowPanel {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
  /** Flexible panels share space by weight and can be resized. */
  readonly defaultWeight?: number;
  readonly minPx?: number;
  /** Fixed panels (e.g. a collapsed rail) take exactly this width and have no splitter. */
  readonly fixedPx?: number;
}

type Weights = Record<string, number>;

const isWeights = (v: unknown): v is Weights =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);

const KEYBOARD_STEP_PX = 24;

/**
 * A horizontal row of panels separated by draggable, keyboard-accessible
 * splitters. Weights are stored per panel id, so hiding a panel (layout mode
 * change) keeps the remaining panels' proportions.
 */
export function ResizableRow({ panels, storageKey }: { panels: readonly RowPanel[]; storageKey: string }) {
  const [weights, setWeights] = usePreference<Weights>(storageKey, {}, isWeights);
  const elements = useRef(new Map<string, HTMLElement>());
  const drag = useRef<{ a: string; b: string; startX: number; pair: PairState } | null>(null);

  const weightOf = useCallback(
    (panel: RowPanel) => weights[panel.id] ?? panel.defaultWeight ?? 1,
    [weights],
  );

  const pairState = (a: RowPanel, b: RowPanel): PairState | null => {
    const elA = elements.current.get(a.id);
    const elB = elements.current.get(b.id);
    if (!elA || !elB) return null;
    return {
      widthA: elA.getBoundingClientRect().width,
      widthB: elB.getBoundingClientRect().width,
      weightA: weightOf(a),
      weightB: weightOf(b),
      minA: a.minPx ?? 120,
      minB: b.minPx ?? 120,
    };
  };

  const apply = (a: string, b: string, pair: PairState, delta: number) => {
    const next = resizePair(pair, delta);
    setWeights((prev) => ({ ...prev, [a]: next.weightA, [b]: next.weightB }));
  };

  const onPointerDown = (a: RowPanel, b: RowPanel) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pair = pairState(a, b);
    if (!pair) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { a: a.id, b: b.id, startX: event.clientX, pair };
    document.body.classList.add('is-resizing');
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    apply(d.a, d.b, d.pair, event.clientX - d.startX);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('is-resizing');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (a: RowPanel, b: RowPanel) => (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_STEP_PX : event.key === 'ArrowRight' ? KEYBOARD_STEP_PX : 0;
    if (!delta) return;
    const pair = pairState(a, b);
    if (!pair) return;
    event.preventDefault();
    apply(a.id, b.id, pair, delta);
  };

  const resetPair = (a: RowPanel, b: RowPanel) => () => {
    setWeights((prev) => {
      const next = { ...prev };
      delete next[a.id];
      delete next[b.id];
      return next;
    });
  };

  // CSS flex distributes only a fraction of free space when the grow factors sum to < 1,
  // so render normalised factors (summing to 100) rather than the raw weights.
  const totalWeight = panels.reduce((sum, p) => (p.fixedPx === undefined ? sum + weightOf(p) : sum), 0) || 1;

  return (
    <div className="resizable-row">
      {panels.map((panel, index) => {
        const prev = index > 0 ? panels[index - 1] : undefined;
        const splitter =
          prev && prev.fixedPx === undefined && panel.fixedPx === undefined ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${prev.label} and ${panel.label}`}
              aria-valuenow={Math.round((100 * weightOf(prev)) / (weightOf(prev) + weightOf(panel)))}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              className="resizable-row__splitter"
              title="Drag to resize · double-click to reset"
              onPointerDown={onPointerDown(prev, panel)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onKeyDown(prev, panel)}
              onDoubleClick={resetPair(prev, panel)}
            />
          ) : null;

        const style =
          panel.fixedPx !== undefined
            ? { flex: `0 0 ${panel.fixedPx}px` }
            : { flex: `${(100 * weightOf(panel)) / totalWeight} 1 0px`, minWidth: panel.minPx ?? 120 };

        return (
          <Fragment key={panel.id}>
            {splitter}
            <div
              className="resizable-row__panel"
              style={style}
              data-panel={panel.id}
              ref={(el) => {
                if (el) elements.current.set(panel.id, el);
                else elements.current.delete(panel.id);
              }}
            >
              {panel.content}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
