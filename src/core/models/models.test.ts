import { describe, expect, it } from 'vitest';
import { buildCallIndex } from '../analysis/python/callIndex';
import { parsePythonModule } from '../parser/python/ast';
import { askTree, bestSplit, buildDemo, growTree, leastSquares, type Point } from './demos';
import { findModels, MODEL_LABELS, modelsAt, type ModelKind } from './detect';

const KINDS = Object.keys(MODEL_LABELS) as ModelKind[];

describe('finding models', () => {
  const src = `import torch
import statsmodels.api as sm
import numpy as np
from mylib import LinearRegression
class Net:
    def fit(self, X):
        cell = {"a": torch.nn.LSTM, "b": torch.nn.GRU}["a"](3, 4)
        return cell
    def predict(self, X):
        return X
def make():
    from sklearn.ensemble import RandomForestRegressor as RF
    return RF(n_estimators=10)
def outer():
    return make()
def stats(x, y):
    return sm.OLS(y, x).fit()
other = LinearRegression()
`;
  const module = parsePythonModule(src);
  const all = new Map([['a.py', findModels('a.py', module)]]);

  it('follows imports, also inside functions, and ignores equal names from elsewhere', () => {
    expect(all.get('a.py')!.map((u) => [u.kind, u.name, u.within, u.line])).toEqual([
      ['lstm', 'torch.nn.LSTM', 'Net.fit', 7],
      ['gru', 'torch.nn.GRU', 'Net.fit', 7],
      ['forest', 'RF', 'make', 13],
      ['linear', 'sm.OLS', 'stats', 17],
    ]);
  });

  it('puts the nearest model first: this line, this function, called functions, its class', () => {
    const calls = buildCallIndex(new Map([['a.py', src]]));
    const at = (within: string | null, line: number | null) => modelsAt({ path: 'a.py', within, line }, all, calls);
    expect(at('stats', 17)).toMatchObject({ here: true, uses: [{ kind: 'linear' }, {}, {}, {}] });
    expect(at('outer', 15).uses[0]!.kind).toBe('forest');
    expect(at('Net.predict', 10)).toMatchObject({ here: false, uses: [{ kind: 'lstm' }, { kind: 'gru' }, {}, {}] });
    expect(modelsAt({ path: 'none.py', within: null, line: 1 }, all, calls).uses).toEqual([]);
  });
});

describe('demos on fake values', () => {
  it.each(KINDS)('%s: has steps, finite numbers, and the same values for the same seed', (kind) => {
    for (const seed of [1, 2, 3]) {
      const demo = buildDemo(kind, seed);
      expect(demo.frames.length).toBeGreaterThan(2);
      expect(JSON.stringify(demo.frames)).toBe(JSON.stringify(buildDemo(kind, seed).frames));
      for (const f of demo.frames) {
        for (const [, v] of f.readouts) expect(Number.isFinite(v)).toBe(true);
        // JSON turns NaN and Infinity into null; only empty network circles and unopened gates may be null.
        if (f.scene.kind === 'plot' || f.scene.kind === 'numbers') expect(JSON.stringify(f.scene)).not.toContain('null');
      }
      if (demo.predict) expect(Number.isFinite(demo.predict.f((demo.predict.min + demo.predict.max) / 2))).toBe(true);
    }
    expect(JSON.stringify(buildDemo(kind, 1).frames)).not.toBe(JSON.stringify(buildDemo(kind, 2).frames));
  });

  it.each(['linear', 'boosting', 'mlp', 'logistic'] as const)('%s really learns: the error goes down', (kind) => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const errors = buildDemo(kind, seed).frames.flatMap((f) => f.readouts.filter(([n]) => n === 'error').map(([, v]) => v));
      expect(errors[errors.length - 1]!).toBeLessThan(errors[0]!);
    }
  });

  it('uses the textbook formulas', () => {
    const line: Point[] = [[0, 1], [1, 3], [2, 5]];
    expect(leastSquares(line)).toEqual({ a: 1, b: 2 });
    expect(leastSquares(line, 2).b).toBe(1);
    const step: Point[] = [[1, 0], [2, 0], [3, 10], [4, 10]];
    expect(bestSplit(step)).toEqual({ at: 2.5, gain: 100 });
    const tree = growTree(step, 1);
    expect([askTree(tree, 1), askTree(tree, 4)]).toEqual([0, 10]);
  });

  it('finds the direction with the most spread', () => {
    const frames = buildDemo('pca', 1).frames;
    const spreads = frames.flatMap((f) => f.readouts.filter(([n]) => n === 'spread').map(([, v]) => v));
    expect(Math.max(...spreads)).toBe(spreads[spreads.length - 1]);
  });
});
