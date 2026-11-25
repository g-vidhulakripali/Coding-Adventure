import { PyError, UnsupportedError } from './errors';
import { numericOf, typeName, type DType, type PyValue } from './values';

/**
 * Python operator semantics for the modelled value subset.
 * Error messages follow CPython 3.12 / NumPy 2 wording.
 */

type NumKind = 'int' | 'float' | 'np-int' | 'np-float';

function numKind(v: PyValue): NumKind | null {
  switch (v.t) {
    case 'int':
    case 'bool':
      return 'int';
    case 'float':
      return 'float';
    case 'np-scalar':
      return v.dtype === 'float64' ? 'np-float' : 'np-int';
    default:
      return null;
  }
}

function makeInt(v: number): PyValue {
  if (!Number.isSafeInteger(v)) throw new UnsupportedError('Integer result exceeds the exact range of the simulation.');
  return { t: 'int', v };
}

function arith(op: string, a: number, b: number, floatResult: boolean, numpy: boolean): number {
  const zeroDiv = (msg: string): never => {
    throw new PyError('ZeroDivisionError', msg);
  };
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0 && !numpy) zeroDiv(floatResult ? 'float division by zero' : 'division by zero');
      return a / b;
    case '//':
      if (b === 0 && !numpy) zeroDiv(floatResult ? 'float floor division by zero' : 'integer division or modulo by zero');
      return Math.floor(a / b);
    case '%': {
      if (b === 0 && !numpy) zeroDiv(floatResult ? 'float modulo by zero' : 'integer modulo by zero');
      const r = a - b * Math.floor(a / b);
      return r;
    }
    case '**':
      if (a === 0 && b < 0 && !numpy) zeroDiv('zero to a negative power');
      return a ** b;
    default:
      throw new UnsupportedError(`Operator \`${op}\` is not modelled yet.`);
  }
}

function numberOp(op: string, a: PyValue, b: PyValue): PyValue | null {
  const ka = numKind(a);
  const kb = numKind(b);
  if (!ka || !kb) return null;
  const x = numericOf(a)!;
  const y = numericOf(b)!;
  const numpy = ka.startsWith('np') || kb.startsWith('np');
  const anyFloat = ka.endsWith('float') || kb.endsWith('float');
  const floatResult = anyFloat || op === '/' || (op === '**' && y < 0);
  const result = arith(op, x, y, anyFloat, numpy);
  if (numpy) return { t: 'np-scalar', dtype: floatResult ? 'float64' : 'int64', v: result };
  return floatResult ? { t: 'float', v: result } : makeInt(result);
}

function elementwise(op: string, a: PyValue, b: PyValue): PyValue | null {
  const arrayLike = (v: PyValue) => v.t === 'ndarray' || v.t === 'series';
  if (!arrayLike(a) && !arrayLike(b)) return null;
  const container = (arrayLike(a) ? a : b) as Extract<PyValue, { t: 'ndarray' | 'series' }>;
  const left = arrayLike(a) ? (a as typeof container).items : null;
  const right = arrayLike(b) ? (b as typeof container).items : null;
  if (left && right && left.length !== right.length) {
    throw new PyError('ValueError', `operands could not be broadcast together with shapes (${left.length},) (${right.length},)`);
  }
  if (a.t === 'series' && b.t === 'series') {
    const label = (s: typeof a, i: number) => s.index?.[i] ?? i;
    if (a.items.some((_, i) => label(a, i) !== label(b, i))) throw new UnsupportedError('Arithmetic between Series with different row labels is not modelled.');
  }
  const n = (left ?? right)!.length;
  const items: PyValue[] = [];
  for (let i = 0; i < n; i++) {
    const x = left ? left[i]! : a;
    const y = right ? right[i]! : b;
    const r = numberOp(op, toNp(x), toNp(y));
    if (!r) throw new UnsupportedError(`Element-wise \`${op}\` on non-numeric data is not modelled.`);
    items.push(r);
  }
  const dtype: DType = items.some((v) => v.t === 'np-scalar' && v.dtype === 'float64') ? 'float64' : 'int64';
  const series = a.t === 'series' ? a : b.t === 'series' ? b : null;
  if (!series) return { t: 'ndarray', dtype, items };
  // pandas keeps the name only when both sides agree on it.
  const keepName = a.t === 'series' && b.t === 'series' ? a.name === b.name : true;
  return { t: 'series', dtype, items, ...(keepName && series.name !== undefined ? { name: series.name } : {}), ...(series.index ? { index: series.index } : {}) };
}

function toNp(v: PyValue): PyValue {
  if (v.t === 'int' || v.t === 'bool') return { t: 'np-scalar', dtype: 'int64', v: numericOf(v)! };
  if (v.t === 'float') return { t: 'np-scalar', dtype: 'float64', v: v.v };
  return v;
}

export function binaryOp(op: string, a: PyValue, b: PyValue): PyValue {
  const numeric = numberOp(op, a, b);
  if (numeric) return numeric;
  const ew = elementwise(op, a, b);
  if (ew) return ew;

  if (op === '+') {
    if (a.t === 'str' && b.t === 'str') return { t: 'str', v: a.v + b.v };
    if (a.t === 'list' && b.t === 'list') return { t: 'list', items: [...a.items, ...b.items] };
    if (a.t === 'tuple' && b.t === 'tuple') return { t: 'tuple', items: [...a.items, ...b.items] };
    if (a.t === 'str') throw new PyError('TypeError', `can only concatenate str (not "${typeName(b)}") to str`);
    if (a.t === 'list') throw new PyError('TypeError', `can only concatenate list (not "${typeName(b)}") to list`);
  }
  if (a.t === 'set' && b.t === 'set' && ['|', '&', '-', '^'].includes(op)) {
    const inA = a.items;
    const inB = b.items;
    const has = (list: readonly PyValue[], v: PyValue) => list.some((o) => pyEquals(o, v));
    const only = inB.filter((v) => !has(inA, v));
    return { t: 'set', items: op === '|' ? [...inA, ...only] : op === '&' ? inA.filter((v) => has(inB, v)) : op === '-' ? inA.filter((v) => !has(inB, v)) : [...inA.filter((v) => !has(inB, v)), ...only] };
  }
  if (a.t === 'dict' && b.t === 'dict' && op === '|') {
    const entries = a.entries.map(([k, v]) => [k, b.entries.find(([k2]) => pyEquals(k2, k))?.[1] ?? v] as const);
    return { t: 'dict', entries: [...entries, ...b.entries.filter(([k]) => !a.entries.some(([k2]) => pyEquals(k2, k)))] };
  }
  if (['&', '|', '^', '<<', '>>'].includes(op) && (a.t === 'int' || a.t === 'bool') && (b.t === 'int' || b.t === 'bool')) {
    const x = numericOf(a)!;
    const y = numericOf(b)!;
    if (Math.abs(x) > 0x7fffffff || Math.abs(y) > 0x7fffffff || (op === '<<' && y > 20)) throw new UnsupportedError(`\`${op}\` on numbers this large is not modelled.`);
    const r = op === '&' ? x & y : op === '|' ? x | y : op === '^' ? x ^ y : op === '<<' ? x * 2 ** y : x >> y;
    return a.t === 'bool' && b.t === 'bool' && op !== '<<' && op !== '>>' ? { t: 'bool', v: r !== 0 } : { t: 'int', v: r };
  }
  if (op === '*') {
    const repeat = (seq: PyValue, n: PyValue): PyValue | null => {
      if (n.t !== 'int') return null;
      const times = Math.max(0, n.v);
      if (seq.t === 'str') return { t: 'str', v: seq.v.repeat(times) };
      if (seq.t === 'list' || seq.t === 'tuple') {
        const items: PyValue[] = [];
        for (let i = 0; i < times; i++) items.push(...seq.items);
        return { t: seq.t, items };
      }
      return null;
    };
    const r = repeat(a, b) ?? repeat(b, a);
    if (r) return r;
  }
  if (a.t === 'str' && op === '%') throw new UnsupportedError('Text formatting with % is not modelled.');
  if (['+', '-', '*', '/', '//', '%', '**'].includes(op)) {
    throw new PyError('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  }
  throw new UnsupportedError(`Operator \`${op}\` is not modelled yet.`);
}

export function unaryOp(op: string, v: PyValue): PyValue {
  if (op === 'not') return { t: 'bool', v: !truthy(v) };
  if (op === '-' || op === '+') {
    const sign = op === '-' ? -1 : 1;
    const k = numKind(v);
    if (k) {
      const n = numericOf(v)! * sign;
      if (v.t === 'np-scalar') return { ...v, v: n };
      return k === 'float' ? { t: 'float', v: n } : makeInt(n);
    }
    if (v.t === 'ndarray' || v.t === 'series') return binaryOp('*', v, { t: 'int', v: sign });
    throw new PyError('TypeError', `bad operand type for unary ${op}: '${typeName(v)}'`);
  }
  if (op === '~' && (v.t === 'int' || v.t === 'bool')) return makeInt(~numericOf(v)!);
  throw new PyError('TypeError', `bad operand type for unary ${op}: '${typeName(v)}'`);
}

export function truthy(v: PyValue): boolean {
  switch (v.t) {
    case 'none':
      return false;
    case 'bool':
      return v.v;
    case 'int':
    case 'float':
    case 'np-scalar':
      return v.v !== 0;
    case 'str':
      return v.v.length > 0;
    case 'list':
    case 'tuple':
    case 'set':
      return v.items.length > 0;
    case 'dict':
      return v.entries.length > 0;
    case 'range':
      return rangeLength(v) > 0;
    case 'ndarray':
      if (v.items.length === 1) return truthy(v.items[0]!);
      throw new PyError('ValueError', 'The truth value of an array with more than one element is ambiguous. Use a.any() or a.all()');
    case 'series':
      throw new PyError('ValueError', 'The truth value of a Series is ambiguous. Use a.empty, a.bool(), a.item(), a.any() or a.all().');
    case 'dataframe':
      throw new PyError('ValueError', 'The truth value of a DataFrame is ambiguous. Use a.empty, a.bool(), a.item(), a.any() or a.all().');
    default:
      return true;
  }
}

export function rangeLength(r: Extract<PyValue, { t: 'range' }>): number {
  const n = Math.ceil((r.stop - r.start) / r.step);
  return Math.max(0, n);
}

export function pyEquals(a: PyValue, b: PyValue): boolean {
  const x = numericOf(a);
  const y = numericOf(b);
  if (x !== null && y !== null) return x === y;
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'none':
      return true;
    case 'str':
      return a.v === (b as typeof a).v;
    case 'list':
    case 'tuple': {
      const other = b as typeof a;
      return a.items.length === other.items.length && a.items.every((v, i) => pyEquals(v, other.items[i]!));
    }
    case 'dict': {
      const other = b as typeof a;
      return a.entries.length === other.entries.length && a.entries.every(([k, v]) => other.entries.some(([k2, v2]) => pyEquals(k, k2) && pyEquals(v, v2)));
    }
    case 'instance':
      return a.id === (b as typeof a).id;
    case 'set': {
      const other = b as typeof a;
      return a.items.length === other.items.length && a.items.every((v) => other.items.some((o) => pyEquals(v, o)));
    }
    default:
      return a === b;
  }
}

function order(op: string, a: PyValue, b: PyValue): boolean {
  const x = numericOf(a);
  const y = numericOf(b);
  let cmp: number | null = null;
  if (x !== null && y !== null) cmp = x < y ? -1 : x > y ? 1 : 0;
  else if (a.t === 'str' && b.t === 'str') cmp = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (cmp === null || (Number.isNaN(x ?? 0) || Number.isNaN(y ?? 0))) {
    if (cmp === null) throw new PyError('TypeError', `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
    return false; // NaN comparisons are always False
  }
  switch (op) {
    case '<':
      return cmp < 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    default:
      return cmp >= 0;
  }
}

function contains(container: PyValue, item: PyValue): boolean {
  switch (container.t) {
    case 'set':
      return container.items.some((v) => pyEquals(v, item));
    case 'series':
      throw new UnsupportedError('`in` on a Series checks row labels, which is not modelled.');
    case 'dataframe':
      return item.t === 'str' && container.columns.some((c) => c.name === item.v);
    case 'str':
      if (item.t !== 'str') throw new PyError('TypeError', `'in <string>' requires string as left operand, not ${typeName(item)}`);
      return container.v.includes(item.v);
    case 'list':
    case 'tuple':
    case 'ndarray':
      return container.items.some((v) => pyEquals(v, item));
    case 'dict':
      return container.entries.some(([k]) => pyEquals(k, item));
    case 'range': {
      const n = numericOf(item);
      if (n === null || !Number.isInteger(n)) return false;
      return n >= container.start && n < container.stop && (n - container.start) % container.step === 0;
    }
    default:
      throw new PyError('TypeError', `argument of type '${typeName(container)}' is not iterable`);
  }
}

export function compareOp(op: string, a: PyValue, b: PyValue): boolean {
  if (a.t === 'ndarray' || a.t === 'series' || b.t === 'ndarray' || b.t === 'series') {
    if (op !== 'in' && op !== 'not in') throw new UnsupportedError('Element-wise comparison of arrays is not modelled yet.');
  }
  switch (op) {
    case '==':
      return pyEquals(a, b);
    case '!=':
      return !pyEquals(a, b);
    case '<':
    case '>':
    case '<=':
    case '>=':
      return order(op, a, b);
    case 'is':
    case 'is not': {
      const singleton = (v: PyValue) => v.t === 'none' || v.t === 'bool';
      if (!singleton(a) && !singleton(b)) throw new UnsupportedError('Object identity (`is`) is only modelled for None, True and False.');
      const same = a.t === b.t && (a.t === 'none' || (a.t === 'bool' && a.v === (b as typeof a).v));
      return op === 'is' ? same : !same;
    }
    case 'in':
      return contains(b, a);
    case 'not in':
      return !contains(b, a);
    default:
      throw new UnsupportedError(`Comparison \`${op}\` is not modelled.`);
  }
}

/** Elements produced by iterating `value`, capped to keep the browser responsive. */
export function iterate(value: PyValue, cap: number): PyValue[] {
  switch (value.t) {
    case 'list':
    case 'tuple':
    case 'ndarray':
    case 'series':
    case 'set':
      return [...value.items];
    case 'str':
      return [...value.v].map((ch) => ({ t: 'str', v: ch }));
    case 'dict':
      return value.entries.map(([k]) => k);
    case 'dataframe':
      // Iterating a DataFrame gives its column names.
      return value.columns.map((c) => ({ t: 'str', v: c.name }));
    case 'range': {
      const n = rangeLength(value);
      if (n > cap) throw new UnsupportedError(`This range has ${n} items; the simulation stops above ${cap} iterations.`);
      return Array.from({ length: n }, (_, i) => ({ t: 'int', v: value.start + i * value.step }));
    }
    default:
      throw new PyError('TypeError', `'${typeName(value)}' object is not iterable`);
  }
}
