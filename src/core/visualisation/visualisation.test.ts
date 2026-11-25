import { describe, expect, it } from 'vitest';
import { buildCallIndex } from '../analysis/python/callIndex';
import { simulate } from '../simulation/interpreter';
import { layoutCallMap } from './callMapLayout';
import { buildScene, describeDestination } from './scene';

const sources = new Map([
  ['main.py', 'from pricing import calculate_total\nprices = [12.0, 8.0, 5.0]\nsubtotal = sum(prices)\ntotal = calculate_total(subtotal, 0.1)\nprint(total)\n'],
  ['pricing.py', 'def calculate_total(subtotal, discount):\n    amount = subtotal * discount\n    return subtotal - helper(amount)\n\ndef helper(x):\n    return x\n\ndef unused():\n    pass\n'],
]);

describe('layoutCallMap', () => {
  const index = buildCallIndex(sources);

  it('places callers left of callees and keeps uncalled functions', () => {
    const layout = layoutCallMap(index, { showExternal: false });
    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.x;
    expect(x('main.py::<module>')).toBeLessThan(x('pricing.py::calculate_total'));
    expect(x('pricing.py::calculate_total')).toBeLessThan(x('pricing.py::helper'));
    expect(layout.nodes.some((n) => n.id === 'pricing.py::unused')).toBe(true);
    expect(layout.edges.map((e) => `${e.from}→${e.to}`).sort()).toEqual(['main.py::<module>→pricing.py::calculate_total', 'pricing.py::calculate_total→pricing.py::helper']);
  });

  it('adds external nodes only on request', () => {
    const withExternal = layoutCallMap(index, { showExternal: true });
    expect(withExternal.nodes.filter((n) => n.kind === 'builtin').map((n) => n.label).sort()).toEqual(['print()', 'sum()']);
    expect(layoutCallMap(index, { showExternal: false }).nodes.some((n) => n.kind === 'builtin')).toBe(false);
  });

  it('survives recursion cycles', () => {
    const cyclic = buildCallIndex(new Map([['r.py', 'def a(n):\n    return b(n)\n\ndef b(n):\n    return a(n - 1)\n']]));
    const layout = layoutCallMap(cyclic, { showExternal: false });
    // The module scope makes no calls, so only a and b are shown, linked both ways.
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['r.py::a', 'r.py::b']);
    expect(layout.edges).toHaveLength(2);
  });
});

describe('buildScene', () => {
  const trace = simulate({ sources }, { kind: 'script', path: 'main.py' });

  it('describes the multiply step inside the callee with its caller behind it', () => {
    const index = trace.steps.findIndex((s) => s.code === 'subtotal * discount');
    const scene = buildScene(trace, index)!;
    expect(scene.frames.map((f) => f.label)).toEqual(['main.py', 'calculate_total() · pricing.py']);
    expect(scene.operation.inputs.map((t) => [t.label, t.display, t.source.kind])).toEqual([
      ['subtotal', '25.0', 'variable'],
      ['discount', '0.1', 'variable'],
    ]);
    expect(scene.operation.output?.display).toBe('2.5');
    // Functions and modules are not drawn as data containers.
    expect(scene.frames[0]!.vars.map((v) => v.name)).toEqual(['prices', 'subtotal']);
  });

  it('marks list elements and the return destination', () => {
    const assign = buildScene(trace, trace.steps.findIndex((s) => s.code.startsWith('prices =')))!;
    expect(assign.frames[0]!.vars[0]).toMatchObject({ name: 'prices', elements: ['12.0', '8.0', '5.0'], changed: true });
    const inner = buildScene(trace, trace.steps.findIndex((s) => s.code === 'return x'))!;
    expect(describeDestination(inner.operation.destination, inner.frames)).toBe('sent back to calculate_total() · pricing.py');
    const outer = buildScene(trace, trace.steps.findIndex((s) => s.code === 'return subtotal - helper(amount)'))!;
    expect(describeDestination(outer.operation.destination, outer.frames)).toBe('sent back to main.py');
  });
});
