import type { ModelKind } from './detect';

/**
 * Live demos: each one really runs the idea of a model, in JavaScript, on FAKE
 * numbers made from a seed. They show how this kind of model works inside. They
 * are never the results of the user's code or data.
 */

export type Point = readonly [number, number];

export interface PlotScene {
  readonly kind: 'plot';
  readonly x: Point;
  readonly y: Point;
  readonly points: ReadonlyArray<{ readonly at: Point; readonly tone?: 'a' | 'b' | 'c' | 'faint' }>;
  readonly curves: ReadonlyArray<{ readonly pts: readonly Point[]; readonly tone: 'main' | 'faint' | 'part' }>;
  /** Error sticks from a point to the model. */
  readonly sticks: ReadonlyArray<{ readonly x: number; readonly y0: number; readonly y1: number }>;
  readonly splits: readonly number[];
  readonly crosses: ReadonlyArray<{ readonly at: Point; readonly tone: 'a' | 'b' | 'c' }>;
}

export interface NetScene {
  readonly kind: 'net';
  /** Node values per layer; null = not worked out yet. */
  readonly layers: ReadonlyArray<ReadonlyArray<number | null>>;
  /** weights[layer][from][to] */
  readonly weights: ReadonlyArray<ReadonlyArray<readonly number[]>>;
  readonly active: number;
  readonly backwards: boolean;
}

export interface CellScene {
  readonly kind: 'cell';
  readonly sequence: readonly number[];
  readonly t: number;
  readonly gates: ReadonlyArray<{ readonly name: string; readonly icon: string; readonly value: number | null; readonly active: boolean }>;
  readonly stores: ReadonlyArray<{ readonly name: string; readonly value: number; readonly active: boolean }>;
  readonly history: readonly number[];
}

export interface NumbersScene {
  readonly kind: 'numbers';
  readonly rows: ReadonlyArray<{ readonly name: string; readonly values: readonly number[]; readonly tone: 'faint' | 'main' }>;
}

export interface DemoFrame {
  /** A few words for the stage. */
  readonly label: string;
  /** One simple sentence. */
  readonly text: string;
  readonly scene: PlotScene | NetScene | CellScene | NumbersScene;
  readonly readouts: ReadonlyArray<readonly [string, number]>;
  readonly ms: number;
}

export interface Demo {
  readonly kind: ModelKind;
  readonly frames: readonly DemoFrame[];
  /** The trained model, for trying an own input: one number in, one number out. */
  readonly predict?: { readonly min: number; readonly max: number; readonly f: (x: number) => number };
  /** Where this demo is simpler than the real thing. */
  readonly simpler: string;
}

// ---- Numbers ------------------------------------------------------------------

export function seeded(seed: number): () => number {
  let a = (seed * 2654435761 + 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const sampleX = (lo: number, hi: number, n = 60) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);

const plot = (o: Partial<PlotScene>): PlotScene => ({ kind: 'plot', x: [0, 10], y: [0, 10], points: [], curves: [], sticks: [], splits: [], crosses: [], ...o });
const frame = (label: string, text: string, scene: DemoFrame['scene'], readouts: DemoFrame['readouts'] = [], ms = 1400): DemoFrame => ({ label, text, scene, readouts, ms });

// ---- Lines --------------------------------------------------------------------

function lineData(seed: number): Point[] {
  const r = seeded(seed);
  const b = between(r, 0.4, 0.75);
  const a = between(r, 1, 2.2);
  return Array.from({ length: 9 }, (_, i) => [round(0.8 + i * 1.05, 2), round(a + b * (0.8 + i * 1.05) + between(r, -1.1, 1.1), 2)] as const);
}

export function leastSquares(pts: readonly Point[], ridge = 0): { a: number; b: number } {
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  const sxy = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const b = sxy / (sxx + ridge);
  return { a: my - b * mx, b };
}
const mse = (pts: readonly Point[], f: (x: number) => number) => mean(pts.map(([x, y]) => (y - f(x)) ** 2));

function lineScene(pts: readonly Point[], f: (x: number) => number, extra: Partial<PlotScene> = {}): PlotScene {
  return plot({
    points: pts.map((at) => ({ at })),
    curves: [{ pts: [[0, f(0)], [10, f(10)]], tone: 'main' }],
    sticks: pts.map(([x, y]) => ({ x, y0: y, y1: f(x) })),
    ...extra,
  });
}

function linear(seed: number): Demo {
  const pts = lineData(seed);
  const best = leastSquares(pts);
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  const frames: DemoFrame[] = [frame('fake dots', 'Here are some made-up measurements. We want one straight line through them.', plot({ points: pts.map((at) => ({ at })) }))];
  const start = { m: 8, b: -0.5 };
  for (let k = 0; k <= 22; k++) {
    // Centre height and slope move towards the answer independently (that is what centring the x values does).
    const q = 0.8 ** k;
    const m = my + (start.m - my) * q;
    const b = best.b + (start.b - best.b) * q;
    const f = (x: number) => m + b * (x - mx);
    frames.push(
      frame(
        k === 0 ? 'bad first line' : 'move, smaller sticks',
        k === 0 ? 'A first bad line. The sticks show how wrong it is at each dot.' : 'Tilt and lift the line so that the sticks get shorter.',
        lineScene(pts, f),
        [['error', round(mse(pts, f))], ['slope', round(b)]],
        k === 0 ? 1800 : 220,
      ),
    );
  }
  const f = (x: number) => best.a + best.b * x;
  frames.push(frame('best line', 'This is the line with the smallest total of squared sticks. No other straight line is better.', lineScene(pts, f), [['start', round(best.a)], ['slope', round(best.b)], ['error', round(mse(pts, f))]], 2200));
  return { kind: 'linear', frames, predict: { min: 0, max: 10, f }, simpler: 'One input instead of many. The real one finds the best line in one calculation, without moving step by step.' };
}

function ridge(seed: number): Demo {
  const pts = lineData(seed).filter((_, i) => i % 2 === 0);
  const plain = leastSquares(pts);
  const p = (x: number) => plain.a + plain.b * x;
  const frames: DemoFrame[] = [
    frame('fake dots', 'Only a few made-up dots. A line that trusts them too much may be wrong.', plot({ points: pts.map((at) => ({ at })) })),
    frame('normal line', 'The normal best line follows the dots closely.', lineScene(pts, p), [['slope', round(plain.b)]], 1800),
  ];
  let last = p;
  for (const lambda of [2, 5, 10, 20, 40]) {
    const r = leastSquares(pts, lambda);
    const f = (x: number) => r.a + r.b * x;
    last = f;
    frames.push(
      frame('pull it flatter', `Ridge adds a rubber band that pulls the slope towards 0. Strength now: ${lambda}.`, lineScene(pts, f, { curves: [{ pts: [[0, p(0)], [10, p(10)]], tone: 'faint' }, { pts: [[0, f(0)], [10, f(10)]], tone: 'main' }] }), [['strength', lambda], ['slope', round(r.b)], ['error', round(mse(pts, f))]], 1100),
    );
  }
  frames.push(frame('a careful line', 'A bit more error on these dots, but a calmer line for new ones.', lineScene(pts, last, { curves: [{ pts: [[0, p(0)], [10, p(10)]], tone: 'faint' }, { pts: [[0, last(0)], [10, last(10)]], tone: 'main' }] }), [], 2200));
  return { kind: 'ridge', frames, predict: { min: 0, max: 10, f: last }, simpler: 'One input instead of many. RidgeCV also tries several strengths and keeps the one that predicts hidden data best.' };
}

function average(seed: number): Demo {
  const pts = lineData(seed);
  const m = mean(pts.map((p) => p[1]));
  const f = () => m;
  return {
    kind: 'mean',
    frames: [
      frame('fake dots', 'Some made-up measurements.', plot({ points: pts.map((at) => ({ at })) })),
      frame('take the average', `Add up all heights and divide by ${pts.length}.`, plot({ points: pts.map((at) => ({ at })), curves: [{ pts: [[0, m], [10, m]], tone: 'main' }] }), [['average', round(m)]], 1800),
      frame('always the same', 'Whatever you ask, it says the average. Other models must beat this.', lineScene(pts, f), [['error', round(mse(pts, f))]], 2200),
    ],
    predict: { min: 0, max: 10, f },
    simpler: 'Nothing is left out.',
  };
}

function scaler(seed: number): Demo {
  const r = seeded(seed);
  const v = Array.from({ length: 5 }, () => Math.round(between(r, 20, 90)));
  const m = mean(v);
  const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
  const centred = v.map((x) => x - m);
  const scaled = centred.map((x) => x / sd);
  const rows = (n: number) =>
    [
      { name: 'fake numbers', values: v },
      { name: 'minus average', values: centred.map((x) => round(x, 1)) },
      { name: 'divided by spread', values: scaled.map((x) => round(x)) },
    ]
      .slice(0, n)
      .map((row, i) => ({ ...row, tone: i === n - 1 ? ('main' as const) : ('faint' as const) }));
  return {
    kind: 'scaler',
    frames: [
      frame('fake numbers', 'Made-up numbers of any size.', { kind: 'numbers', rows: rows(1) }),
      frame('average', 'Find their average and how spread out they are.', { kind: 'numbers', rows: rows(1) }, [['average', round(m, 1)], ['spread', round(sd, 1)]], 1800),
      frame('minus average', 'Take the average away. Now they sit around 0.', { kind: 'numbers', rows: rows(2) }, [['average', round(m, 1)]], 1800),
      frame('÷ spread', 'Divide by the spread. Now all columns are equally big, so none shouts louder.', { kind: 'numbers', rows: rows(3) }, [['new average', 0], ['new spread', 1]], 2200),
    ],
    simpler: 'One column instead of many; every column is scaled by itself in the same way.',
  };
}

// ---- Trees --------------------------------------------------------------------

function waveData(seed: number): Point[] {
  const r = seeded(seed);
  const phase = between(r, 0, 2);
  return Array.from({ length: 18 }, (_, i) => [round(0.4 + i * 0.54, 2), round(5 + 3 * Math.sin(0.75 * (0.4 + i * 0.54) + phase) + between(r, -0.8, 0.8), 2)] as const);
}

export type Tree = { readonly value: number } | { readonly at: number; readonly left: Tree; readonly right: Tree };
const sse = (v: readonly number[]) => {
  const m = mean(v);
  return v.reduce((s, x) => s + (x - m) ** 2, 0);
};

export function bestSplit(pts: readonly Point[], minLeaf = 2): { at: number; gain: number } | null {
  const s = [...pts].sort((a, b) => a[0] - b[0]);
  const total = sse(s.map((p) => p[1]));
  let best: { at: number; gain: number } | null = null;
  for (let i = minLeaf; i <= s.length - minLeaf; i++) {
    if (s[i]![0] === s[i - 1]![0]) continue;
    const gain = total - sse(s.slice(0, i).map((p) => p[1])) - sse(s.slice(i).map((p) => p[1]));
    if (!best || gain > best.gain) best = { at: (s[i - 1]![0] + s[i]![0]) / 2, gain };
  }
  return best && best.gain > 1e-9 ? best : null;
}

export function growTree(pts: readonly Point[], depth: number, minLeaf = 2): Tree {
  const split = depth > 0 && pts.length >= 2 * minLeaf ? bestSplit(pts, minLeaf) : null;
  if (!split) return { value: mean(pts.map((p) => p[1])) };
  return { at: split.at, left: growTree(pts.filter((p) => p[0] <= split.at), depth - 1, minLeaf), right: growTree(pts.filter((p) => p[0] > split.at), depth - 1, minLeaf) };
}
export function askTree(t: Tree, x: number): number {
  return 'value' in t ? t.value : askTree(x <= t.at ? t.left : t.right, x);
}
const splitsOf = (t: Tree): number[] => ('value' in t ? [] : [t.at, ...splitsOf(t.left), ...splitsOf(t.right)]);
const steps = (f: (x: number) => number): Point[] => sampleX(0, 10, 200).map((x) => [x, f(x)] as const);
const dots = (pts: readonly Point[], tone?: 'faint') => pts.map((at) => ({ at, ...(tone ? { tone } : {}) }));

function tree(seed: number): Demo {
  const pts = waveData(seed);
  const frames: DemoFrame[] = [frame('fake dots', 'Made-up measurements that go up and down.', plot({ points: dots(pts) }))];
  const questions = ['one step', 'ask 1 question', 'ask 2 questions deep', 'ask 3 questions deep'];
  let f = (_: number): number => 0;
  for (let d = 0; d <= 3; d++) {
    const t = growTree(pts, d);
    f = (x) => askTree(t, x);
    frames.push(
      frame(questions[d]!, d === 0 ? 'Start: say the average everywhere.' : 'Find the best place to cut, so that the dots on each side are most alike. Each piece says its own average.', plot({ points: dots(pts), curves: [{ pts: steps(f), tone: 'main' }], splits: splitsOf(t) }), [['pieces', splitsOf(t).length + 1], ['error', round(mse(pts, f))]], 2000),
    );
  }
  return { kind: 'tree', frames, predict: { min: 0, max: 10, f }, simpler: 'One input instead of many. A real tree may cut on a different column at each question.' };
}

function forest(seed: number): Demo {
  const pts = waveData(seed);
  const r = seeded(seed + 99);
  const frames: DemoFrame[] = [frame('fake dots', 'Made-up measurements. We will ask many trees, not one.', plot({ points: dots(pts) }))];
  const trees: Tree[] = [];
  const avg = (x: number) => mean(trees.map((t) => askTree(t, x)));
  for (let k = 1; k <= 8; k++) {
    const picked = Array.from({ length: pts.length }, () => pts[Math.floor(r() * pts.length)]!);
    const t = growTree(picked, 3, 2);
    trees.push(t);
    const one = (x: number) => askTree(t, x);
    frames.push(frame(`tree ${k}`, 'Draw dots at random (some twice, some never) and grow a tree on them.', plot({ points: [...dots(pts, 'faint'), ...dots(picked)], curves: [{ pts: steps(one), tone: 'part' }] }), [['trees', k]], k <= 2 ? 1500 : 650));
    frames.push(frame('average of all', 'Every tree gives its answer. The forest says their average.', plot({ points: dots(pts), curves: [...trees.map((x) => ({ pts: steps((v) => askTree(x, v)), tone: 'faint' as const })), { pts: steps(avg), tone: 'main' }] }), [['trees', k], ['error', round(mse(pts, avg))]], k <= 2 ? 1600 : 650));
  }
  frames.push(frame('the forest', 'One tree is jumpy. The average of many is calm.', plot({ points: dots(pts), curves: [{ pts: steps(avg), tone: 'main' }] }), [['trees', 8], ['error', round(mse(pts, avg))]], 2200));
  return { kind: 'forest', frames, predict: { min: 0, max: 10, f: avg }, simpler: '8 trees and one input instead of hundreds of trees and many inputs. Real forests may also let each question choose from only some of the columns.' };
}

function boosting(seed: number): Demo {
  const pts = waveData(seed);
  const rate = 0.5;
  const start = mean(pts.map((p) => p[1]));
  const trees: Tree[] = [];
  const f = (x: number) => start + rate * trees.reduce((s, t) => s + askTree(t, x), 0);
  const frames: DemoFrame[] = [
    frame('fake dots', 'Made-up measurements.', plot({ points: dots(pts) })),
    frame('start: average', 'First answer: the average for everything. The sticks are what is still wrong.', plot({ points: dots(pts), curves: [{ pts: steps(f), tone: 'main' }], sticks: pts.map(([x, y]) => ({ x, y0: y, y1: f(x) })) }), [['error', round(mse(pts, f))]], 2000),
  ];
  for (let k = 1; k <= 12; k++) {
    const left = pts.map(([x, y]) => [x, y - f(x)] as const);
    const t = growTree(left, 2, 2);
    if (k <= 3) {
      frames.push(frame('leftover errors', 'Look only at the leftover errors (0 is the middle). Grow a small tree that predicts them.', plot({ y: [-5, 5], points: dots(left), curves: [{ pts: steps((x) => askTree(t, x)), tone: 'part' }, { pts: [[0, 0], [10, 0]], tone: 'faint' }] }), [['round', k]], 1800));
    }
    const before = steps(f);
    trees.push(t);
    frames.push(frame(`round ${k}`, `Add half of that small tree to the answer. The sticks get shorter.`, plot({ points: dots(pts), curves: [{ pts: before, tone: 'faint' }, { pts: steps(f), tone: 'main' }], sticks: pts.map(([x, y]) => ({ x, y0: y, y1: f(x) })) }), [['round', k], ['error', round(mse(pts, f))]], k <= 3 ? 1800 : 500));
  }
  frames.push(frame('all small trees', 'Many small trees, each fixing what the ones before got wrong.', plot({ points: dots(pts), curves: [{ pts: steps(f), tone: 'main' }] }), [['trees', 12], ['error', round(mse(pts, f))]], 2200));
  return { kind: 'boosting', frames, predict: { min: 0, max: 10, f }, simpler: '12 small trees, one input, and half of each tree added. Real boosting (XGBoost, histogram boosting) uses many more and extra brakes against learning noise.' };
}

// ---- Neural networks ------------------------------------------------------------

function mlp(seed: number): Demo {
  const r = seeded(seed);
  const samples = Array.from({ length: 6 }, () => {
    const a = round(between(r, -1, 1), 1);
    const b = round(between(r, -1, 1), 1);
    return { in: [a, b] as const, out: round(0.7 * a - 0.5 * b * b, 2) };
  });
  const H = 3;
  const w1 = [0, 1].map(() => Array.from({ length: H }, () => between(r, -0.9, 0.9)));
  const b1 = Array.from({ length: H }, () => between(r, -0.3, 0.3));
  const w2 = Array.from({ length: H }, () => between(r, -0.9, 0.9));
  let b2 = 0;
  const forward = (x: readonly number[]) => {
    const h = Array.from({ length: H }, (_, j) => Math.tanh(x[0]! * w1[0]![j]! + x[1]! * w1[1]![j]! + b1[j]!));
    return { h, y: h.reduce((s, v, j) => s + v * w2[j]!, b2) };
  };
  const loss = () => mean(samples.map((s) => (forward(s.in).y - s.out) ** 2));
  const weights = () => [w1.map((row) => [...row]), w2.map((v) => [v])];
  const train = () => {
    const g1 = [0, 1].map(() => Array<number>(H).fill(0));
    const gb = Array<number>(H).fill(0);
    const g2 = Array<number>(H).fill(0);
    let gy = 0;
    for (const s of samples) {
      const { h, y } = forward(s.in);
      const d = (2 * (y - s.out)) / samples.length;
      gy += d;
      for (let j = 0; j < H; j++) {
        g2[j]! += d * h[j]!;
        const dh = d * w2[j]! * (1 - h[j]! ** 2);
        gb[j]! += dh;
        g1[0]![j]! += dh * s.in[0];
        g1[1]![j]! += dh * s.in[1];
      }
    }
    const rate = 0.4;
    for (let j = 0; j < H; j++) {
      w2[j]! -= rate * g2[j]!;
      b1[j]! -= rate * gb[j]!;
      w1[0]![j]! -= rate * g1[0]![j]!;
      w1[1]![j]! -= rate * g1[1]![j]!;
    }
    b2 -= rate * gy;
  };
  const net = (layers: NetScene['layers'], active: number, backwards = false): NetScene => ({ kind: 'net', layers, weights: weights(), active, backwards });
  const none = Array<null>(H).fill(null);
  const frames: DemoFrame[] = [];
  const curve: number[] = [loss()];
  for (let e = 0; e < 60; e++) {
    const s = samples[e % samples.length]!;
    const { h, y } = forward(s.in);
    const out: DemoFrame['readouts'] = [['wanted', s.out], ['round', e + 1], ['error', round(curve[curve.length - 1]!, 3)]];
    if (e < 2) {
      frames.push(frame('numbers go in', 'Two made-up numbers go into the network.', net([[...s.in], none, [null]], 0), out, 1500));
      frames.push(frame('× weights, add, squeeze', 'Each middle circle multiplies by its line weights, adds up, and squeezes the result between −1 and 1.', net([[...s.in], h.map((v) => round(v)), [null]], 1), out, 2000));
      frames.push(frame('the answer', 'The last circle adds up the middle circles the same way. That is the answer.', net([[...s.in], h.map((v) => round(v)), [round(y)]], 2), out, 1800));
      train();
      frames.push(frame('fix the weights', 'Compare with the wanted answer, go backwards, and nudge every line a little in the direction that makes the error smaller.', net([[...s.in], h.map((v) => round(v)), [round(y)]], 2, true), out, 2000));
    } else {
      train();
      if (e % 3 === 0) frames.push(frame('again and again', 'Over and over: answer, compare, nudge. The error shrinks.', net([[...s.in], h.map((v) => round(v)), [round(y)]], 2, true), out, 280));
    }
    curve.push(loss());
  }
  frames.push(frame('error gets smaller', 'The error after every round of learning.', plot({ x: [0, 60], y: [0, Math.max(...curve) * 1.1], curves: [{ pts: curve.map((v, i) => [i, v] as const), tone: 'main' }] }), [['first error', round(curve[0]!, 3)], ['last error', round(curve[curve.length - 1]!, 3)]], 2200));
  return {
    kind: 'mlp',
    frames,
    simpler: '2 inputs and 3 middle circles instead of many. Real networks may use another squeezing rule and a cleverer way to nudge (Adam).',
  };
}

function recurrent(kind: 'lstm' | 'gru', seed: number): Demo {
  const r = seeded(seed);
  const sequence = Array.from({ length: 6 }, (_, i) => round(Math.sin(i * 1.1 + between(r, 0, 2)) + between(r, -0.2, 0.2), 1));
  const w = () => between(r, -1.4, 1.4);
  const gate = () => ({ x: w(), h: w(), b: between(r, -0.4, 0.8) });
  const G = { f: gate(), i: gate(), g: gate(), o: gate() };
  const at = (k: { x: number; h: number; b: number }, x: number, h: number) => k.x * x + k.h * h + k.b;
  let h = 0;
  let c = 0;
  const history: number[] = [];
  const frames: DemoFrame[] = [];
  const run = (t: number) => {
    const x = sequence[t]!;
    const slow = t < 2;
    const ms = slow ? 1900 : 800;
    const names =
      kind === 'lstm'
        ? ([['forget', '🚪'], ['new', '✏️'], ['show', '👀']] as const)
        : ([['reset', '🧹'], ['update', '✏️']] as const);
    const values: Array<number | null> = names.map(() => null);
    const show = (label: string, text: string, active: number, store: string | null, readouts: DemoFrame['readouts'] = []) =>
      frames.push(
        frame(
          label,
          text,
          {
            kind: 'cell',
            sequence,
            t,
            gates: names.map(([name, icon], i) => ({ name, icon, value: values[i] === null ? null : round(values[i]!), active: i === active })),
            stores: [...(kind === 'lstm' ? [{ name: 'memory', value: round(c), active: store === 'memory' }] : []), { name: 'output', value: round(h), active: store === 'output' }],
            history: [...history],
          },
          readouts,
          ms,
        ),
      );
    show('next number', `Made-up number ${t + 1} of ${sequence.length} comes in, together with what is remembered.`, -1, null);
    if (kind === 'lstm') {
      const f = sigmoid(at(G.f, x, h));
      values[0] = f;
      show('forget gate', `How much of the memory to keep? ${Math.round(f * 100)} out of 100.`, 0, null);
      const i = sigmoid(at(G.i, x, h));
      const g = Math.tanh(at(G.g, x, h));
      values[1] = i;
      show('new gate', `How much of the new idea (${round(g)}) to write down? ${Math.round(i * 100)} out of 100.`, 1, null, [['new idea', round(g)]]);
      const before = c;
      c = f * c + i * g;
      show('memory', `Memory = ${round(f)} × ${round(before)} + ${round(i)} × ${round(g)} = ${round(c)}.`, -1, 'memory');
      const o = sigmoid(at(G.o, x, h));
      values[2] = o;
      h = o * Math.tanh(c);
      history.push(h);
      show('show gate', `How much of the memory to show? ${Math.round(o * 100)} out of 100. That is the output.`, 2, 'output');
    } else {
      const reset = sigmoid(at(G.f, x, h));
      values[0] = reset;
      show('reset gate', `How much of the past to use for the new idea? ${Math.round(reset * 100)} out of 100.`, 0, null);
      const idea = Math.tanh(at(G.g, x, reset * h));
      const z = sigmoid(at(G.i, x, h));
      values[1] = z;
      const before = h;
      h = (1 - z) * h + z * idea;
      history.push(h);
      show('update gate', `Mix: ${round(1 - z)} × old (${round(before)}) + ${round(z)} × new idea (${round(idea)}) = ${round(h)}.`, 1, 'output', [['new idea', round(idea)]]);
    }
  };
  for (let t = 0; t < sequence.length; t++) run(t);
  const last = frames[frames.length - 1]!;
  const y = 1.3 * h + 0.2;
  frames.push(frame('the prediction', `After the last number, one more small sum turns the output into the prediction: 1.3 × ${round(h)} + 0.2 = ${round(y)}.`, last.scene, [['prediction', round(y)]], 2400));
  return {
    kind,
    frames,
    simpler: `One memory number and fixed, untrained weights, to show how a ${kind.toUpperCase()} reads a row of numbers in order. A real one has many and learns its weights.`,
  };
}

// ---- Groups and directions --------------------------------------------------------

function cloud(seed: number): Point[] {
  const r = seeded(seed);
  const angle = between(r, 0.4, 1.1);
  return Array.from({ length: 22 }, () => {
    const u = between(r, -3.6, 3.6);
    const v = between(r, -0.9, 0.9);
    return [round(5 + u * Math.cos(angle) - v * Math.sin(angle), 2), round(5 + u * Math.sin(angle) + v * Math.cos(angle), 2)] as const;
  });
}

function pca(seed: number): Demo {
  const pts = cloud(seed);
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  const sxx = mean(pts.map(([x]) => (x - mx) ** 2));
  const syy = mean(pts.map(([, y]) => (y - my) ** 2));
  const sxy = mean(pts.map(([x, y]) => (x - mx) * (y - my)));
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const spread = (a: number) => mean(pts.map(([x, y]) => ((x - mx) * Math.cos(a) + (y - my) * Math.sin(a)) ** 2));
  const lineAt = (a: number) => ({ pts: [[mx - 5 * Math.cos(a), my - 5 * Math.sin(a)], [mx + 5 * Math.cos(a), my + 5 * Math.sin(a)]] as Point[], tone: 'main' as const });
  const onto = (a: number) => pts.map(([x, y]) => {
    const u = (x - mx) * Math.cos(a) + (y - my) * Math.sin(a);
    return [mx + u * Math.cos(a), my + u * Math.sin(a)] as Point;
  });
  const frames: DemoFrame[] = [
    frame('fake dots', 'Made-up dots with two numbers each.', plot({ points: dots(pts) })),
    frame('find the middle', 'Find the middle of the cloud.', plot({ points: dots(pts), crosses: [{ at: [mx, my], tone: 'a' }] }), [], 1600),
  ];
  for (let k = 0; k <= 14; k++) {
    const a = theta + 1.35 * (1 - k / 14);
    frames.push(frame('turn the arrow', 'Turn an arrow until the dots are most spread out along it.', plot({ points: dots(pts), curves: [lineAt(a)], crosses: [{ at: [mx, my], tone: 'a' }] }), [['spread', round(spread(a))]], k === 0 ? 1300 : 220));
  }
  const total = sxx + syy;
  frames.push(frame('drop onto the arrow', 'Push every dot onto the arrow. Two numbers became one.', plot({ points: [...dots(pts, 'faint'), ...onto(theta).map((at) => ({ at, tone: 'a' as const }))], curves: [lineAt(theta)] }), [['kept %', round((100 * spread(theta)) / total, 1)]], 2400));
  return { kind: 'pca', frames, simpler: '2 numbers per dot instead of many. The real one finds the directions in one calculation, without turning.' };
}

function kmeans(seed: number): Demo {
  const r = seeded(seed);
  const homes: Point[] = [[2.5, 3], [7.2, 2.6], [5, 7.4]];
  const pts = homes.flatMap(([x, y]) => Array.from({ length: 8 }, () => [round(x + between(r, -1.5, 1.5), 2), round(y + between(r, -1.5, 1.5), 2)] as Point));
  let centres = [0, 1, 2].map((k) => pts[Math.floor(r() * 8) + k * 3]!);
  const tones = ['a', 'b', 'c'] as const;
  const nearest = (p: Point) => centres.map((c) => (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2).reduce((best, d, i, all) => (d < all[best]! ? i : best), 0);
  const marks = () => centres.map((at, i) => ({ at, tone: tones[i]! }));
  const frames: DemoFrame[] = [frame('fake dots', 'Made-up dots. We want 3 groups.', plot({ points: dots(pts) })), frame('3 flags', 'Put 3 flags somewhere.', plot({ points: dots(pts), crosses: marks() }))];
  for (let k = 0; k < 8; k++) {
    const group = pts.map(nearest);
    const coloured = pts.map((at, i) => ({ at, tone: tones[group[i]!]! }));
    frames.push(frame('join nearest flag', 'Every dot joins its nearest flag.', plot({ points: coloured, crosses: marks() }), [['round', k + 1]], 1300));
    const next = centres.map((c, i) => {
      const mine = pts.filter((_, j) => group[j] === i);
      return mine.length ? ([mean(mine.map((p) => p[0])), mean(mine.map((p) => p[1]))] as Point) : c;
    });
    const still = next.every((c, i) => Math.hypot(c[0] - centres[i]![0], c[1] - centres[i]![1]) < 1e-9);
    centres = next;
    if (still) break;
    frames.push(frame('move the flags', 'Every flag walks to the middle of its dots.', plot({ points: coloured, crosses: marks() }), [['round', k + 1]], 1300));
  }
  const end = frames[frames.length - 1]!;
  frames.push(frame('done', 'Nothing changes any more: these are the groups.', end.scene, [], 2000));
  return { kind: 'kmeans', frames, simpler: '2 numbers per dot instead of many. The real one also tries several starting places.' };
}

function logistic(seed: number): Demo {
  const r = seeded(seed);
  const pts = Array.from({ length: 14 }, (_, i) => {
    const x = 0.6 + i * 0.68;
    return [round(x, 2), sigmoid(1.2 * (x - 5) + between(r, -1.6, 1.6)) > 0.5 ? 1 : 0] as Point;
  });
  let w = -0.4;
  let b = 0;
  const f = (x: number) => sigmoid(w * (x - 5) + b);
  const loss = () => -mean(pts.map(([x, y]) => Math.log(Math.max(1e-9, y ? f(x) : 1 - f(x)))));
  const scene = () => plot({ y: [-0.15, 1.15], points: pts.map((at) => ({ at, tone: at[1] ? ('a' as const) : ('b' as const) })), curves: [{ pts: sampleX(0, 10).map((x) => [x, f(x)] as const), tone: 'main' }] });
  const frames: DemoFrame[] = [frame('no (0) or yes (1)', 'Made-up dots: each is either no (below) or yes (above).', plot({ ...scene(), curves: [] })), frame('bad first curve', 'The curve says how sure we are of “yes”. This first one is wrong.', scene(), [['error', round(loss())]], 1800)];
  for (let k = 0; k < 24; k++) {
    for (let j = 0; j < 4; j++) {
      const gw = mean(pts.map(([x, y]) => (f(x) - y) * (x - 5)));
      const gb = mean(pts.map(([x, y]) => f(x) - y));
      w -= 0.12 * gw;
      b -= 0.12 * gb;
    }
    frames.push(frame('bend the curve', 'Nudge the curve so that yes-dots get high and no-dots get low.', scene(), [['error', round(loss())]], 220));
  }
  frames.push(frame('how sure?', 'Read the curve: near 1 means yes, near 0 means no.', scene(), [['error', round(loss())]], 2200));
  return { kind: 'logistic', frames, predict: { min: 0, max: 10, f }, simpler: 'One input instead of many.' };
}

export function buildDemo(kind: ModelKind, seed: number): Demo {
  switch (kind) {
    case 'linear':
      return linear(seed);
    case 'ridge':
      return ridge(seed);
    case 'mean':
      return average(seed);
    case 'scaler':
      return scaler(seed);
    case 'tree':
      return tree(seed);
    case 'forest':
      return forest(seed);
    case 'boosting':
      return boosting(seed);
    case 'mlp':
      return mlp(seed);
    case 'lstm':
    case 'gru':
      return recurrent(kind, seed);
    case 'pca':
      return pca(seed);
    case 'kmeans':
      return kmeans(seed);
    case 'logistic':
      return logistic(seed);
  }
}
