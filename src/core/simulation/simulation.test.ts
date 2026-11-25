import { describe, expect, it } from 'vitest';
import { parsePythonModule } from '../parser/python/ast';
import { simulate, type SimulationProgram } from './interpreter';
import { parseLiteral } from './literal';
import { findEditableInputs, findScenarios } from './scenarios';
import { floatRepr, pyRepr, type PyValue } from './values';

const MAIN = `from pricing import calculate_total

prices = [12.0, 8.0, 5.0]
discount = 0.10

subtotal = sum(prices)

total = calculate_total(subtotal, discount)

print(total)
`;

const PRICING = `def calculate_total(subtotal, discount):
    discount_amount = subtotal * discount
    final_amount = subtotal - discount_amount

    return final_amount
`;

const USAGE = `import pandas as pd


def usage_for_first_station(hours_usage, stationary):
    result = float(
        hours_usage.to_numpy(dtype=float)[stationary.iloc[0]]
    )
    return result


if __name__ == "__main__":
    hours_usage = pd.Series([10.5, 20.0, 30.5])
    stationary = pd.Series([2, 0, 1])
    print(usage_for_first_station(hours_usage, stationary))
`;

const program = (files: Record<string, string>): SimulationProgram => ({ sources: new Map(Object.entries(files)) });
const shop = program({ 'main.py': MAIN, 'pricing.py': PRICING });
const usage = program({ 'analysis/usage.py': USAGE });
const show = (v: PyValue | null) => (v ? pyRepr(v) : null);

describe('Example 1 — function execution across files', () => {
  const trace = simulate(shop, { kind: 'script', path: 'main.py' });

  it('completes and prints 22.5', () => {
    expect(trace.status).toBe('completed');
    expect(trace.console).toEqual(['22.5']);
  });

  it('records the required operations in execution order with exact code', () => {
    const summary = trace.steps.map((s) => `${s.kind}|${s.span.path}:${s.span.startLine}|${s.code.split('\n')[0]}|${show(s.output)}`);
    expect(summary).toEqual([
      'import|main.py:1|from pricing import calculate_total|null',
      'define|pricing.py:1|def calculate_total(subtotal, discount):|<function calculate_total>',
      'import|main.py:1|from pricing import calculate_total|<function calculate_total>',
      'assign|main.py:3|prices = [12.0, 8.0, 5.0]|[12.0, 8.0, 5.0]',
      'assign|main.py:4|discount = 0.10|0.1',
      'builtin|main.py:6|sum(prices)|25.0',
      'assign|main.py:6|subtotal = sum(prices)|25.0',
      'call|main.py:8|calculate_total(subtotal, discount)|null',
      'enter|pricing.py:1|def calculate_total(subtotal, discount):|null',
      'operation|pricing.py:2|subtotal * discount|2.5',
      'assign|pricing.py:2|discount_amount = subtotal * discount|2.5',
      'operation|pricing.py:3|subtotal - discount_amount|22.5',
      'assign|pricing.py:3|final_amount = subtotal - discount_amount|22.5',
      'return|pricing.py:5|return final_amount|22.5',
      'assign|main.py:8|total = calculate_total(subtotal, discount)|22.5',
      'print|main.py:10|print(total)|None',
    ]);
  });

  it('links values to where they came from and where they go next', () => {
    const byCode = (code: string) => trace.steps.find((s) => s.code === code)!;
    const sum = byCode('sum(prices)');
    const pricesAssign = byCode('prices = [12.0, 8.0, 5.0]');
    expect(sum.inputs[0]).toMatchObject({ label: 'prices', fromVariable: 'prices', fromStep: pricesAssign.id });
    expect(pricesAssign.usedBy).toBe(sum.id);
    expect(sum.usedBy).toBe(byCode('subtotal = sum(prices)').id);

    const call = byCode('calculate_total(subtotal, discount)');
    expect(call.inputs.map((i) => [i.label, i.name, show(i.value)])).toEqual([
      ['subtotal', 'subtotal', '25.0'],
      ['discount', 'discount', '0.1'],
    ]);
    const ret = byCode('return final_amount');
    expect(ret.target).toEqual({ kind: 'return', callerFrameId: expect.any(Number), callStep: call.id });
    expect(ret.usedBy).toBe(byCode('total = calculate_total(subtotal, discount)').id);
  });

  it('shows exact expression columns for highlighting', () => {
    const mult = trace.steps.find((s) => s.code === 'subtotal * discount')!;
    expect(mult.span).toEqual({ path: 'pricing.py', startLine: 2, startColumn: 22, endLine: 2, endColumn: 41 });
  });

  it('keeps a call stack snapshot per step', () => {
    const inside = trace.steps.find((s) => s.code === 'subtotal * discount')!;
    expect(inside.frames.map((f) => f.name)).toEqual(['<module>', 'calculate_total']);
    expect(inside.frames[1]!.vars.map((v) => [v.name, show(v.value)])).toEqual([
      ['subtotal', '25.0'],
      ['discount', '0.1'],
    ]);
  });

  it('recomputes from edited inputs', () => {
    const inputs = findEditableInputs('main.py', parsePythonModule(MAIN));
    expect(inputs.map((i) => [i.name, i.code])).toEqual([
      ['prices', '[12.0, 8.0, 5.0]'],
      ['discount', '0.10'],
    ]);
    const parsed = parseLiteral('[10, 20, 30, 40]');
    if (!parsed.ok) throw new Error(parsed.error);
    const discount = parseLiteral('0.25');
    if (!discount.ok) throw new Error(discount.error);
    const edited = simulate(shop, { kind: 'script', path: 'main.py' }, { overrides: new Map([[inputs[0]!.key, parsed.value], [inputs[1]!.key, discount.value]]) });
    expect(edited.console).toEqual(['75.0']);
    expect(show(edited.steps.find((s) => s.code === 'sum(prices)')!.output)).toBe('100');
  });
});

describe('Example 2 — pandas / NumPy indexing expression', () => {
  const trace = simulate(usage, { kind: 'script', path: 'analysis/usage.py' });

  it('completes with 30.5', () => {
    expect(trace.status).toBe('completed');
    expect(trace.console).toEqual(['30.5']);
  });

  it('follows Python evaluation order and shows each sub-expression', () => {
    const inner = trace.steps.filter((s) => s.span.startLine >= 5 && s.span.startLine <= 7).map((s) => [s.kind, s.code.replace(/\s+/g, ' '), show(s.output)]);
    expect(inner).toEqual([
      ['method', 'hours_usage.to_numpy(dtype=float)', 'array([10.5, 20.0, 30.5])'],
      ['index', 'stationary.iloc[0]', '2'],
      ['index', 'hours_usage.to_numpy(dtype=float)[stationary.iloc[0]]', '30.5'],
      ['builtin', 'float( hours_usage.to_numpy(dtype=float)[stationary.iloc[0]] )', '30.5'],
      ['assign', 'result = float( hours_usage.to_numpy(dtype=float)[stationary.iloc[0]] )', '30.5'],
    ]);
  });

  it('explains where the index 2 came from and which array it selects from', () => {
    const iloc = trace.steps.find((s) => s.code === 'stationary.iloc[0]')!;
    expect(iloc.selectedIndex).toBe(0);
    expect(iloc.output).toEqual({ t: 'np-scalar', dtype: 'int64', v: 2 });
    const pick = trace.steps.find((s) => s.kind === 'index' && s.code.startsWith('hours_usage'))!;
    expect(pick.inputs.map((i) => [i.role, i.label])).toEqual([
      ['receiver', 'hours_usage.to_numpy(dtype=float)'],
      ['index', 'stationary.iloc[0]'],
    ]);
    expect(pick.inputs[1]!.fromStep).toBe(iloc.id);
    expect(pick.selectedIndex).toBe(2);
    expect(pick.output).toEqual({ t: 'np-scalar', dtype: 'float64', v: 30.5 });
    const toFloat = trace.steps.find((s) => s.kind === 'builtin' && s.code.startsWith('float('))!;
    expect(toFloat.output).toEqual({ t: 'float', v: 30.5 });
  });

  it('models an out-of-range index as IndexError and stops', () => {
    const inputs = findEditableInputs('analysis/usage.py', parsePythonModule(USAGE));
    expect(inputs.map((i) => [i.name, i.code, i.context])).toEqual([
      ['hours_usage', '[10.5, 20.0, 30.5]', 'passed to pd.Series(…)'],
      ['stationary', '[2, 0, 1]', 'passed to pd.Series(…)'],
    ]);
    const bad = parseLiteral('[5, 0, 1]');
    if (!bad.ok) throw new Error(bad.error);
    const t = simulate(usage, { kind: 'script', path: 'analysis/usage.py' }, { overrides: new Map([[inputs[1]!.key, bad.value]]) });
    expect(t.status).toBe('stopped');
    expect(t.stop?.message).toBe('IndexError: index 5 is out of bounds for axis 0 with size 3');
    const last = t.steps[t.steps.length - 1]!;
    expect(last.kind).toBe('error');
    expect(last.code).toBe('hours_usage.to_numpy(dtype=float)[stationary.iloc[0]]');
    // Recorded before the stack unwinds, so the variables at the failure point are visible.
    expect(last.frames.map((f) => f.name)).toEqual(['<module>', 'usage_for_first_station']);
    expect(last.frames[1]!.vars.map((v) => v.name)).toEqual(['hours_usage', 'stationary']);
  });
});

describe('honest limits', () => {
  it('shows `?` for unknown libraries and keeps going', () => {
    const t = simulate(program({ 'a.py': 'import requests\nr = requests.get("x")\nn = 2 + 3\ntotal = r.count + n\n' }), { kind: 'script', path: 'a.py' });
    expect(t.status).toBe('completed');
    expect(t.steps.find((s) => s.kind === 'unknown')).toMatchObject({ code: 'requests.get("x")', evidence: 'unsupported' });
    const last = t.steps[t.steps.length - 1]!;
    expect(last.frames[0]!.vars.filter((x) => ['r', 'n', 'total'].includes(x.name)).map((x) => `${x.name}=${show(x.value)}`)).toEqual(['r=?', 'n=5', 'total=?']);
  });

  it('assumes a direction for unknown conditions, marks it, and lets the user switch it', () => {
    const files = { 'a.py': 'import requests\nif requests.ok():\n    x = 1\nelse:\n    x = 2\n' };
    const t = simulate(program(files), { kind: 'script', path: 'a.py' });
    const d = t.steps.find((s) => s.assumption)!;
    expect(d).toMatchObject({ kind: 'decision', evidence: 'inferred', assumption: { taken: true } });
    expect(t.assumptions.join(' ')).toContain('assumes yes');
    const flipped = simulate(program(files), { kind: 'script', path: 'a.py' }, { choices: new Map([[d.assumption!.key, false]]) });
    expect(show(flipped.steps[flipped.steps.length - 1]!.output)).toBe('2');
  });

  it('never keeps numbers that depend on an unknown number of repetitions', () => {
    const src = 'import requests\ntotal = 0\nseen = []\nfor r in requests.get():\n    total += 1\n    seen.append(1)\nn = len(seen)\n';
    const t = simulate(program({ 'a.py': src }), { kind: 'script', path: 'a.py' });
    const vars = Object.fromEntries(t.steps[t.steps.length - 1]!.frames[0]!.vars.map((x) => [x.name, show(x.value)]));
    expect(vars).toMatchObject({ total: '?', seen: '?', n: '?' });
  });

  it('runs a function without arguments: they stay `?`', () => {
    const t = simulate(program({ 'a.py': 'def f(a, b=2):\n    c = b * 10\n    return a + c\n' }), { kind: 'function', path: 'a.py', name: 'f', args: new Map() });
    expect(t.status).toBe('completed');
    expect(t.steps.filter((s) => s.kind === 'assign').map((s) => show(s.output))).toEqual(['20']);
    expect(show(t.steps.find((s) => s.kind === 'return')!.output)).toBe('?');
  });

  it('models Python errors with CPython wording', () => {
    const t = simulate(program({ 'a.py': 'a = 1\nb = 0\nc = a / b\n' }), { kind: 'script', path: 'a.py' });
    expect(t.stop?.message).toBe('ZeroDivisionError: division by zero');
  });

  it('stops runaway loops', () => {
    const t = simulate(program({ 'a.py': 'n = 0\nwhile True:\n    n += 1\n' }), { kind: 'script', path: 'a.py' }, { maxIterations: 20 });
    expect(t.stop?.kind).toBe('limit');
  });
});

describe('control flow', () => {
  it('records decisions, loops and returns', () => {
    const src = `def grade(score):
    if score >= 90:
        return "A"
    elif score >= 50:
        return "pass"
    else:
        return "fail"

total = 0
for s in [45, 20]:
    total += s
print(grade(total), total)
`;
    const t = simulate(program({ 'g.py': src }), { kind: 'script', path: 'g.py' });
    expect(t.status).toBe('completed');
    expect(t.console).toEqual(["pass 65"]);
    expect(t.steps.filter((s) => s.kind === 'loop').map((s) => s.title)).toEqual(['Iteration 1 of 2', 'Iteration 2 of 2', 'Loop finished']);
    expect(t.steps.filter((s) => s.kind === 'decision').map((s) => s.title)).toEqual(['Condition false → skip branch', 'Condition true → enter branch']);
  });

  it('runs a function directly with user inputs', () => {
    const t = simulate(shop, { kind: 'function', path: 'pricing.py', name: 'calculate_total', args: new Map<string, PyValue>([['subtotal', { t: 'float', v: 100 }], ['discount', { t: 'float', v: 0.2 }]]) });
    expect(t.status).toBe('completed');
    const ret = t.steps.find((s) => s.kind === 'return')!;
    expect(show(ret.output)).toBe('80.0');
    expect(t.assumptions.some((a) => a.includes('called directly'))).toBe(true);
  });
});

describe('scenarios', () => {
  it('offers scripts and plain functions', () => {
    expect(findScenarios('main.py', parsePythonModule(MAIN)).map((s) => s.label)).toEqual(['Run main.py as a script']);
    expect(findScenarios('pricing.py', parsePythonModule(PRICING)).map((s) => s.label)).toEqual(['Call calculate_total(subtotal, discount)']);
  });
});

describe('Python formatting', () => {
  it.each([
    [25, '25.0'],
    [22.5, '22.5'],
    [0.1, '0.1'],
    [0.1 + 0.2, '0.30000000000000004'],
    [1e16, '1e+16'],
    [1.5e-5, '1.5e-05'],
    [123456789012345.6, '123456789012345.6'],
    [0.0001, '0.0001'],
    [-0, '-0.0'],
  ])('floatRepr(%s) = %s', (n, text) => {
    expect(floatRepr(n)).toBe(text);
  });

  it('parses literals typed by users', () => {
    expect(parseLiteral(' [1, 2.5, "a", True, None, -3] ')).toEqual({
      ok: true,
      value: { t: 'list', items: [{ t: 'int', v: 1 }, { t: 'float', v: 2.5 }, { t: 'str', v: 'a' }, { t: 'bool', v: true }, { t: 'none' }, { t: 'int', v: -3 }] },
    });
    expect(parseLiteral('[1, 2').ok).toBe(false);
    expect(parseLiteral('os.system("x")').ok).toBe(false);
  });
});
