import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Trace } from '../../core/simulation/trace';
import { buildLineView, type LineNode } from '../../core/visualisation/lines';
import type { Scene, SceneValue } from '../../core/visualisation/scene';
import { MiniTable, StoryBanner } from './StoryBanner';
import './Stage2D.css';

export interface Stage2DProps {
  readonly scene: Scene;
  readonly trace: Trace;
  readonly stepIndex: number;
  readonly sources: ReadonlyMap<string, string>;
  readonly durationMs?: number;
  /** Switches the assumed answer of a decision that is not known. */
  readonly onChoose?: (key: string, taken: boolean) => void;
}

/**
 * Line-by-line view: the function (or file) that is running is a container of
 * its own source lines. The current line is lit and shows its numbers moving;
 * finished lines show their results; if/else, loops and classes are nested
 * containers. A call opens the called function's container; the caller waits
 * above as a one-line card.
 */
export function Stage2D({ scene, trace, stepIndex, sources, durationMs = 0, onChoose }: Stage2DProps) {
  const assumption = trace.steps[stepIndex]?.assumption ?? null;
  const chooser =
    assumption && onChoose ? (
      <div className="lines2d__choose" role="group" aria-label="The answer is not known. Choose which way to go.">
        {([true, false] as const).map((taken) => (
          <button key={String(taken)} type="button" aria-pressed={assumption.taken === taken} onClick={() => onChoose(assumption.key, taken)}>
            {taken ? 'yes' : 'no'}
          </button>
        ))}
      </div>
    ) : null;
  const root = useRef<HTMLDivElement>(null);
  const view = useMemo(() => buildLineView(trace, stepIndex, sources), [trace, stepIndex, sources]);
  const current = scene.frames[scene.frames.length - 1];
  const op = scene.operation;
  const selectedVar = op.selectedIndex !== null && op.inputs[0]?.source.kind === 'variable' ? op.inputs[0].source.name : null;
  const targets = op.destination.kind === 'variable' || op.destination.kind === 'params' ? op.destination.names : [];
  const inputs = op.inputs.filter((i) => i.source.kind === 'variable').map((i) => (i.source as { name: string }).name);
  const involved = new Set([...targets, ...inputs]);

  // Animate the numbers: they fly out of their boxes into the sum, the answer pops in,
  // and a stored value flies into its box. Only on single forward steps (durationMs > 0).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || durationMs <= 0 || typeof el.animate !== 'function') return;
    const unit = durationMs / 6;
    const boxOf = (name: string | null | undefined) => (name ? el.querySelector<HTMLElement>(`[data-var="${CSS.escape(name)}"]`) : null);
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
    let t = 0;
    const tiles = [...el.querySelectorAll<HTMLElement>('.story__tiles > .tile')];
    for (const tile of tiles) {
      const kind = tile.dataset.kind;
      const from = boxOf(tile.dataset.source);
      if (from && (kind === 'value' || kind === 'list')) {
        const a = centre(from.getBoundingClientRect());
        const b = centre(tile.getBoundingClientRect());
        tile.animate(
          [
            { transform: `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(0.6)`, opacity: 0.4 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: unit * 1.6, delay: t, easing: ease, fill: 'backwards' },
        );
        t += unit * 0.55;
      } else if (kind === 'result') {
        t += unit * 0.9;
        tile.animate(
          [
            { transform: 'scale(0.2)', opacity: 0 },
            { transform: 'scale(1.18)', opacity: 1, offset: 0.7 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: unit * 1.3, delay: t, easing: ease, fill: 'backwards' },
        );
        t += unit * 1.1;
      } else {
        tile.animate([{ opacity: 0 }, { opacity: 1 }], { duration: unit * 0.8, delay: t, fill: 'backwards' });
        t += unit * 0.25;
      }
    }
    // A copy of the stored / printed value travels to its box (or the console), which glows on arrival.
    const carried = tiles.find((x) => x.dataset.kind === 'value' || x.dataset.kind === 'list' || x.dataset.kind === 'result');
    const destinations = [
      ...targets.map((n) => boxOf(n)),
      op.destination.kind === 'console' ? el.querySelector<HTMLElement>('.stage2d__console') : null,
    ].filter((d): d is HTMLElement => d !== null);
    if (carried && destinations.length > 0 && op.kind !== 'operation' && op.kind !== 'index' && op.kind !== 'builtin' && op.kind !== 'method') {
      const base = el.getBoundingClientRect();
      for (const dest of destinations) {
        const ghost = carried.cloneNode(true) as HTMLElement;
        const from = carried.getBoundingClientRect();
        const to = dest.getBoundingClientRect();
        ghost.classList.add('tile--ghost');
        Object.assign(ghost.style, { position: 'absolute', left: `${from.left - base.left + el.scrollLeft}px`, top: `${from.top - base.top + el.scrollTop}px`, margin: '0' });
        el.appendChild(ghost);
        const dx = to.left + to.width / 2 - (from.left + from.width / 2);
        const dy = to.top + to.height / 2 - (from.top + from.height / 2);
        const fly = ghost.animate(
          [
            { transform: 'none', opacity: 0 },
            { transform: 'none', opacity: 1, offset: 0.15 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.7)`, opacity: 0.9 },
          ],
          { duration: unit * 1.8, delay: t, easing: ease, fill: 'both' },
        );
        fly.onfinish = () => ghost.remove();
        fly.oncancel = () => ghost.remove();
        dest.animate(
          [{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 8px color-mix(in srgb, var(--lab-value) 55%, transparent)', offset: 0.4 }, { boxShadow: '0 0 0 0 transparent' }],
          { duration: unit * 1.4, delay: t + unit * 1.6 },
        );
        // The box shows its new number only when it arrives.
        const value = dest.querySelector<HTMLElement>('.var2d__value, .var2d__elements, pre');
        value?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: unit * 0.5, delay: t + unit * 1.6, fill: 'backwards' });
      }
    }
    return () => {
      el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      el.querySelectorAll('.tile--ghost').forEach((g) => g.remove());
    };
  }, [op.stepId, durationMs]);

  // Keep the current line in view.
  useLayoutEffect(() => {
    root.current?.querySelector('.ln.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [op.stepId]);

  return (
    <div className="stage2d" key={op.stepId} ref={root}>
      {view?.callers.map((c, i) => (
        <div key={i} className="lines2d__caller" title={`Waiting in ${c.path} for the helper to finish`}>
          <span aria-hidden="true">{i === 0 ? '🏠' : '🧑‍🍳'}</span>
          <b>{c.name}</b>
          <span className="lines2d__no">{c.line}</span>
          <code>{c.code}</code>
          <span className="lines2d__wait" aria-label="waiting">⏳</span>
        </div>
      ))}

      {view ? (
        <section className={`lines2d__frame is-${view.frame.kind}`} aria-label={`Lines of ${view.frame.name}`}>
          <header className={`lines2d__head${view.headerCurrent ? ' is-current' : ''}`}>
            <span aria-hidden="true">{view.frame.kind === 'function' ? (view.frame.owner ? '🧩' : '🧑‍🍳') : view.frame.kind === 'inputs' ? '✍️' : '📄'}</span>
            {view.frame.owner ? <span className="lines2d__owner">{view.frame.owner} ›</span> : null}
            <b>{view.frame.name}</b>
            {view.frame.kind === 'function' ? (
              <span className="lines2d__params">
                (
                {view.frame.params.map((p, i) => (
                  <span key={p.name} className="lines2d__param">
                    {i > 0 ? ', ' : ''}
                    {p.name} <span className="lines2d__chip is-value">{p.value}</span>
                  </span>
                ))}
                )
              </span>
            ) : null}
          </header>
          {view.headerCurrent ? (
            <div className="ln__story">
              <StoryBanner story={scene.story} variant="row" />
            </div>
          ) : null}
          {view.nodes.length > 0 ? (
            <ol className="lines2d__list">
              {view.nodes.map((n, i) => (
                <LineRow key={i} node={n} scene={scene} extra={chooser} />
              ))}
            </ol>
          ) : null}
        </section>
      ) : (
        <StoryBanner story={scene.story} variant="stage" />
      )}

      <section className="stage2d__shelf" aria-label="Boxes (variables) right now">
        {current && current.vars.length > 0 ? (
          <div className="stage2d__boxes">
            {current.vars.map((v) => (
              <div
                key={v.name}
                data-var={v.name}
                className={`var2d${targets.includes(v.name) ? ' is-target' : ''}${inputs.includes(v.name) && !targets.includes(v.name) ? ' is-input' : ''}${involved.size > 0 && !involved.has(v.name) ? ' is-quiet' : ''}${v.elements ? ' is-collection' : ''}`}
              >
                <div className="var2d__head">
                  <b>{v.name}</b>
                </div>
                <ValueView value={v} selected={selectedVar === v.name ? op.selectedIndex : null} />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {scene.console.length > 0 ? (
        <section className="stage2d__console" aria-label="Console output">
          <span aria-hidden="true">🖥️</span>
          <pre>{scene.console.slice(-6).join('\n')}</pre>
        </section>
      ) : null}
    </div>
  );
}

const BLOCK_ICON: Record<string, string> = { if: '🔀', 'if-branch': '', elif: '', else: '', for: '🔁', while: '🔁', def: '📜', class: '🧩', with: '🔓', try: '🧪', except: '🧤', finally: '🏁' };

/** One source line, or a container (if / loop / class) with its lines inside. */
function LineRow({ node, scene, extra }: { node: LineNode; scene: Scene; extra: ReactNode }) {
  const isBlock = node.kind === 'block';
  return (
    <li className={`ln is-${node.status}${isBlock ? ` ln--block ln--${node.label}` : ''}`}>
      {node.label !== 'if' ? (
        <div className="ln__row">
          <span className="ln__no">{node.line}</span>
          {isBlock && BLOCK_ICON[node.label ?? ''] ? <span aria-hidden="true">{BLOCK_ICON[node.label ?? '']}</span> : null}
          <code className="ln__code">{node.code}</code>
          {node.chip && node.status !== 'current' ? <span className={`lines2d__chip${node.chip === 'no' || node.chip === '✗' ? ' is-no' : node.chip.includes('?') ? ' is-unknown' : node.chip === 'yes' ? ' is-yes' : ''}`}>{node.chip}</span> : null}
        </div>
      ) : null}
      {node.status === 'current' ? (
        <div className="ln__story">
          <StoryBanner story={scene.story} variant="row" />
          {extra}
        </div>
      ) : null}
      {node.children.length > 0 ? (
        <ol className="ln__children">
          {node.children.map((c, i) => (
            <LineRow key={i} node={c} scene={scene} extra={extra} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ValueView({ value, selected }: { value: SceneValue; selected: number | null }) {
  if (value.fields) {
    return (
      <div className="var2d__object">
        <span className="var2d__cls">🧩 {value.type}</span>
        {value.fields.length === 0 ? <small>empty</small> : null}
        {value.fields.map(([k, v]) => (
          <span key={k} className="var2d__field">
            <small>{k}</small>
            <b>{v}</b>
          </span>
        ))}
      </div>
    );
  }
  if (value.table) return <MiniTable header={value.table.header} rows={value.table.rows} more={value.table.more} />;
  if (!value.elements) return <div className="var2d__value">{value.display}</div>;
  return (
    <ol className="var2d__elements">
      {value.elements.slice(0, 12).map((el, i) => (
        <li key={i} className={selected === i ? 'is-selected' : undefined}>
          <span>{el}</span>
          <small>{i}</small>
        </li>
      ))}
      {value.elements.length > 12 ? <li className="is-more">+{value.elements.length - 12}</li> : null}
    </ol>
  );
}
