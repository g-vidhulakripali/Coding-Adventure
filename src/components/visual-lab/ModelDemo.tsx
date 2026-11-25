import { useEffect, useMemo, useState } from 'react';
import { buildDemo, type CellScene, type DemoFrame, type NetScene, type NumbersScene, type PlotScene, type Point } from '../../core/models/demos';
import { MODEL_LABELS, type ModelUse } from '../../core/models/detect';
import type { LineRange } from '../../core/source-mapping/types';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import './ModelDemo.css';

export interface ModelDemoProps {
  readonly uses: readonly ModelUse[];
  readonly onClose: () => void;
  readonly onNavigate: (path: string, lines: LineRange) => void;
}

/** Live demo of what happens inside a kind of model, on fake numbers. */
export function ModelDemo({ uses, onClose, onNavigate }: ModelDemoProps) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [kind, setKind] = useState(uses[0]!.kind);
  const use = uses.find((u) => u.kind === kind) ?? uses[0]!;
  const [seed, setSeed] = useState(1);
  const demo = useMemo(() => buildDemo(use.kind, seed), [use.kind, seed]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const at = Math.min(index, demo.frames.length - 1);
  const frame = demo.frames[at]!;
  const atEnd = at === demo.frames.length - 1;

  const restart = () => {
    setIndex(0);
    setPlaying(!reducedMotion);
  };
  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex(at + 1), frame.ms);
    return () => window.clearTimeout(timer);
  }, [playing, at, atEnd, frame]);

  const range = demo.predict ?? null;
  const [probe, setProbe] = useState(0.6);
  const x = range ? range.min + probe * (range.max - range.min) : 0;
  const trying = range !== null && atEnd;
  const answer = trying ? range.f(x) : null;

  return (
    <section className="model-demo" aria-label={`Inside the model: ${MODEL_LABELS[use.kind]}, with fake values`}>
      <header className="model-demo__head">
        <span aria-hidden="true">🧠</span>
        {uses.length > 1 ? (
          <select
            value={use.kind}
            onChange={(e) => {
              setKind(e.target.value as ModelUse['kind']);
              restart();
            }}
            aria-label="Which model"
          >
            {uses.map((u) => (
              <option key={u.kind} value={u.kind}>
                {MODEL_LABELS[u.kind]}
              </option>
            ))}
          </select>
        ) : (
          <b>{MODEL_LABELS[use.kind]}</b>
        )}
        <button type="button" className="model-demo__where" onClick={() => onNavigate(use.path, { startLine: use.line, endLine: use.endLine })} title={`${use.path}:${use.line}`}>
          {use.name} · line {use.line}
        </button>
        <span className="model-demo__fake" title="Made-up numbers. These are not results of your code or data.">
          fake values
        </span>
        <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} title="Back to the lines" aria-label="Close the model demo">
          ✕
        </button>
      </header>

      <div className="model-demo__stage">
        <p className="model-demo__label" aria-hidden="true">
          {trying && range ? 'try a number' : frame.label}
        </p>
        <SceneView scene={frame.scene} probe={trying && answer !== null && frame.scene.kind === 'plot' ? [x, answer] : null} />
        <div className="model-demo__readouts">
          {frame.readouts.map(([name, value]) => (
            <span key={name}>
              <small>{name}</small> <b>{value}</b>
            </span>
          ))}
        </div>
        {trying && range && answer !== null ? (
          <label className="model-demo__try">
            <span>give it</span>
            <input type="range" min={0} max={1} step={0.01} value={probe} onChange={(e) => setProbe(Number(e.target.value))} aria-label="Number to give to the model" />
            <b>{x.toFixed(1)}</b>
            <span aria-hidden="true">→</span>
            <b className="model-demo__answer">{answer.toFixed(2)}</b>
          </label>
        ) : null}
      </div>

      <p className="model-demo__text" aria-live="polite">
        {frame.text}
      </p>
      <div className="model-demo__controls" role="toolbar" aria-label="Model demo playback">
        <button type="button" className="btn btn--icon btn--ghost" onClick={() => setIndex(Math.max(0, at - 1))} disabled={at === 0} aria-label="Previous">
          ‹
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            if (atEnd) setIndex(0);
            setPlaying(!playing || atEnd);
          }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : atEnd ? '↻' : '▶'}
        </button>
        <button type="button" className="btn btn--icon btn--ghost" onClick={() => setIndex(Math.min(demo.frames.length - 1, at + 1))} disabled={atEnd} aria-label="Next">
          ›
        </button>
        <input
          type="range"
          min={0}
          max={demo.frames.length - 1}
          value={at}
          onChange={(e) => {
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
          aria-label="Demo step"
        />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setSeed(seed + 1);
            restart();
          }}
        >
          new fake values
        </button>
      </div>
      <p className="model-demo__note">
        How this kind of model works, not your results. {demo.simpler}
      </p>
    </section>
  );
}

function SceneView({ scene, probe }: { scene: DemoFrame['scene']; probe: Point | null }) {
  switch (scene.kind) {
    case 'plot':
      return <Plot scene={scene} probe={probe} />;
    case 'net':
      return <Net scene={scene} />;
    case 'cell':
      return <Cell scene={scene} />;
    case 'numbers':
      return <Numbers scene={scene} />;
  }
}

const W = 420;
const H = 260;
const PAD = 14;

function Plot({ scene, probe }: { scene: PlotScene; probe: Point | null }) {
  const sx = (x: number) => PAD + ((x - scene.x[0]) / (scene.x[1] - scene.x[0])) * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - scene.y[0]) / (scene.y[1] - scene.y[0])) * (H - 2 * PAD);
  const path = (pts: readonly Point[]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join('');
  return (
    <svg className="demo-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Chart with fake values">
      <defs>
        <clipPath id="demo-clip">
          <rect x={PAD} y={PAD} width={W - 2 * PAD} height={H - 2 * PAD} />
        </clipPath>
      </defs>
      <path d={`M${PAD} ${PAD}V${H - PAD}H${W - PAD}`} className="demo-axis" />
      <g clipPath="url(#demo-clip)">
        {scene.splits.map((x) => (
          <line key={x} x1={sx(x)} x2={sx(x)} y1={PAD} y2={H - PAD} className="demo-split" />
        ))}
        {scene.sticks.map((s, i) => (
          <line key={i} x1={sx(s.x)} x2={sx(s.x)} y1={sy(s.y0)} y2={sy(s.y1)} className="demo-stick" />
        ))}
        {scene.curves.map((c, i) => (
          <path key={i} d={path(c.pts)} className={`demo-curve is-${c.tone}`} />
        ))}
      </g>
      {scene.points.map((p, i) => (
        <circle key={i} cx={sx(p.at[0])} cy={sy(p.at[1])} r={5} className={`demo-dot is-${p.tone ?? 'plain'}`} />
      ))}
      {scene.crosses.map((c, i) => (
        <text key={i} x={sx(c.at[0])} y={sy(c.at[1])} className={`demo-flag is-${c.tone}`} textAnchor="middle" dominantBaseline="central">
          ⚑
        </text>
      ))}
      {probe ? (
        <g className="demo-probe">
          <path d={`M${sx(probe[0])} ${H - PAD}V${sy(probe[1])}H${PAD}`} />
          <circle cx={sx(probe[0])} cy={sy(probe[1])} r={7} />
        </g>
      ) : null}
    </svg>
  );
}

function Net({ scene }: { scene: NetScene }) {
  const x = (l: number) => 60 + (l * (W - 120)) / (scene.layers.length - 1);
  const y = (l: number, i: number) => {
    const n = scene.layers[l]!.length;
    return H / 2 + (i - (n - 1) / 2) * 74;
  };
  return (
    <svg className="demo-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Neural network with fake values">
      {scene.weights.map((from, l) =>
        from.map((to, i) =>
          to.map((w, j) => (
            <line
              key={`${l}-${i}-${j}`}
              x1={x(l)}
              y1={y(l, i)}
              x2={x(l + 1)}
              y2={y(l + 1, j)}
              className={`demo-weight ${w < 0 ? 'is-minus' : 'is-plus'}${scene.backwards || scene.active === l + 1 ? ' is-active' : ''}${scene.backwards ? ' is-back' : ''}`}
              strokeWidth={1 + Math.min(5, Math.abs(w) * 3)}
            />
          )),
        ),
      )}
      {scene.layers.map((layer, l) =>
        layer.map((v, i) => (
          <g key={`${l}-${i}`} className={`demo-node${scene.active === l ? ' is-active' : ''}${v === null ? ' is-empty' : ''}`}>
            <circle cx={x(l)} cy={y(l, i)} r={26} />
            <text x={x(l)} y={y(l, i)} textAnchor="middle" dominantBaseline="central">
              {v === null ? '' : v}
            </text>
          </g>
        )),
      )}
    </svg>
  );
}

function Cell({ scene }: { scene: CellScene }) {
  return (
    <div className="demo-cell">
      <ol className="demo-cell__seq" aria-label="Fake numbers, in order">
        {scene.sequence.map((v, i) => (
          <li key={i} className={i === scene.t ? 'is-now' : i < scene.t ? 'is-done' : undefined}>
            {v}
          </li>
        ))}
      </ol>
      <div className="demo-cell__box">
        <div className="demo-cell__gates">
          {scene.gates.map((g) => (
            <div key={g.name} className={`demo-gate${g.active ? ' is-active' : ''}`}>
              <span aria-hidden="true">{g.icon}</span>
              <small>{g.name}</small>
              <span className="demo-gate__bar">
                <i style={{ width: `${(g.value ?? 0) * 100}%` }} />
              </span>
              <b>{g.value === null ? '·' : g.value}</b>
            </div>
          ))}
        </div>
        <div className="demo-cell__stores">
          {scene.stores.map((s) => (
            <div key={s.name} className={`demo-store${s.active ? ' is-active' : ''}`}>
              <small>{s.name}</small>
              <b>{s.value}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Numbers({ scene }: { scene: NumbersScene }) {
  return (
    <div className="demo-numbers">
      {scene.rows.map((row) => (
        <div key={row.name} className={`demo-numbers__row is-${row.tone}`}>
          <small>{row.name}</small>
          <div>
            {row.values.map((v, i) => (
              <b key={i}>{v}</b>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
