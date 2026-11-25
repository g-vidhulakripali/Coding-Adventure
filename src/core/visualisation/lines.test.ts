import { describe, expect, it } from 'vitest';
import { simulate } from '../simulation/interpreter';
import { buildLineView, type LineNode } from './lines';

const sources = new Map([
  ['main.py', 'from pricing import calculate_total\n\nprices = [12.0, 8.0, 5.0]\nsubtotal = sum(prices)\ntotal = calculate_total(subtotal, 0.1)\nprint(total)\n'],
  ['pricing.py', 'def calculate_total(subtotal, discount):\n    amount = subtotal * discount\n    if amount > 100:\n        amount = 100\n    else:\n        amount = amount + 0\n    return subtotal - amount\n'],
  ['loop.py', 'total = 0\nfor n in [1, 2, 3]:\n    total += n\nprint(total)\n'],
]);

const flat = (nodes: readonly LineNode[]): LineNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
const at = (path: string, code: string) => {
  const trace = simulate({ sources }, { kind: 'script', path });
  const index = trace.steps.findIndex((s) => s.code.replace(/\s+/g, ' ').trim() === code);
  return buildLineView(trace, index, sources)!;
};

describe('buildLineView', () => {
  it('shows the running file line by line with results on finished lines', () => {
    const view = at('main.py', 'calculate_total(subtotal, 0.1)');
    expect(view.frame).toMatchObject({ kind: 'module', name: 'main.py' });
    expect(view.nodes.map((n) => [n.line, n.status, n.chip])).toEqual([
      [1, 'done', null],
      [3, 'done', '= [12.0 8.0 5.0]'],
      [4, 'done', '= 25.0'],
      [5, 'current', null],
      [6, 'pending', null],
    ]);
  });

  it('opens the called function as its own container, with the caller waiting above', () => {
    const view = at('main.py', 'subtotal * discount');
    expect(view.frame).toMatchObject({ kind: 'function', name: 'calculate_total', params: [{ name: 'subtotal', value: '25.0' }, { name: 'discount', value: '0.1' }] });
    expect(view.callers).toEqual([{ name: 'main.py', path: 'main.py', line: 5, code: 'total = calculate_total(subtotal, 0.1)' }]);
    expect(view.nodes[0]).toMatchObject({ line: 2, status: 'current' });
  });

  it('draws if / else as a container: taken branch lit, the other skipped', () => {
    const view = at('main.py', 'return subtotal - amount');
    const ifNode = view.nodes.find((n) => n.label === 'if')!;
    expect(ifNode.children.map((b) => [b.label, b.status, b.chip])).toEqual([
      ['if-branch', 'skipped', 'no'],
      ['else', 'done', 'yes'],
    ]);
    expect(flat(ifNode.children[0]!.children).every((n) => n.status === 'skipped')).toBe(true);
    expect(ifNode.children[1]!.children[0]).toMatchObject({ status: 'done', chip: '= 2.5' });
  });

  it('shows a loop as a container with an item counter', () => {
    const trace = simulate({ sources }, { kind: 'script', path: 'loop.py' });
    const second = trace.steps.findIndex((s) => s.title === 'Iteration 2 of 3');
    const loop = buildLineView(trace, second, sources)!.nodes.find((n) => n.label === 'for')!;
    expect(loop).toMatchObject({ code: 'for n in [1, 2, 3]', status: 'current', chip: '2/3' });
  });
});
