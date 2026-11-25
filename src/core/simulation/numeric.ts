import { PyError, UnsupportedError } from './errors';
import { binaryOp, compareOp, iterate, pyEquals } from './operators';
import { numericOf, pyFloat, pyInt, typeName, type DType, type PyValue } from './values';

/**
 * JavaScript models of common NumPy, pandas, `math` and `os.path` operations.
 * Only 1-D data and only forms whose result is certain. Everything else raises
 * UnsupportedError, which the interpreter shows as `?` (not computed).
 * Floating-point sums may differ from the libraries in the last digits.
 */

export type Series = Extract<PyValue, { t: 'series' }>;
export type NdArray = Extract<PyValue, { t: 'ndarray' }>;
export type DataFrame = Extract<PyValue, { t: 'dataframe' }>;
type Kwargs = ReadonlyMap<string, PyValue>;

const CAP = 20000;
const f64 = (v: number): PyValue => ({ t: 'np-scalar', dtype: 'float64', v });
const i64 = (v: number): PyValue => ({ t: 'np-scalar', dtype: 'int64', v });
const nbool = (v: boolean): PyValue => ({ t: 'np-scalar', dtype: 'bool', v: v ? 1 : 0 });
const no = (what: string): never => {
  throw new UnsupportedError(`${what} is not modelled.`);
};

function nums(v: PyValue, what: string): number[] {
  const items = v.t === 'list' || v.t === 'tuple' || v.t === 'ndarray' || v.t === 'series' ? v.items : v.t === 'range' ? iterate(v, CAP) : null;
  if (!items) return no(`${what} of ${typeName(v)}`);
  return items.map((x) => numericOf(x) ?? no(`${what} over non-numeric data`));
}

const allInt = (v: PyValue): boolean =>
  (v.t === 'ndarray' || v.t === 'series' ? v.dtype === 'int64' : v.t === 'list' || v.t === 'tuple' ? v.items.length > 0 && v.items.every((x) => x.t === 'int' || (x.t === 'np-scalar' && x.dtype === 'int64')) : v.t === 'range') ||
  v.t === 'int' ||
  (v.t === 'np-scalar' && v.dtype === 'int64');

const arr = (values: readonly number[], dtype: DType): NdArray => ({ t: 'ndarray', dtype, items: values.map((v) => ({ t: 'np-scalar', dtype: dtype as 'float64' | 'int64' | 'bool', v })) });

/** Same container kind (and row labels) as `like`, with new numbers. */
function withItems(like: PyValue, items: readonly PyValue[], dtype: DType): PyValue {
  if (like.t === 'series') return { ...like, dtype, items };
  return { t: 'ndarray', dtype, items };
}

const isArray = (v: PyValue): v is Series | NdArray => v.t === 'series' || v.t === 'ndarray';

const UNARY: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  log1p: Math.log1p,
  expm1: Math.expm1,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  arctan: Math.atan,
  floor: Math.floor,
  ceil: Math.ceil,
};

function median(values: readonly number[]): number {
  if (values.length === 0 || values.some(Number.isNaN)) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Linear-interpolated quantile (NumPy/pandas default). */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0 || values.some(Number.isNaN)) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo);
}

function variance(values: readonly number[], ddof: number): number {
  const n = values.length;
  if (n - ddof <= 0) return NaN;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - ddof);
}

/** Round half to even at `d` decimals, the way np.round works. */
function roundEven(x: number, d: number): number {
  if (!Number.isFinite(x)) return x;
  const k = 10 ** d;
  const y = x * k;
  const r = Math.round(y);
  return (Math.abs(y % 1) === 0.5 ? 2 * Math.round(y / 2) : r) / k;
}

const REDUCTIONS = ['sum', 'mean', 'median', 'std', 'var', 'min', 'max', 'prod', 'ptp'];

function reduceNums(name: string, values: readonly number[], int: boolean, ddof: number): PyValue {
  const typed = int ? i64 : f64;
  switch (name) {
    case 'sum':
      return typed(values.reduce((a, b) => a + b, 0));
    case 'prod':
      return typed(values.reduce((a, b) => a * b, 1));
    case 'mean':
      return f64(values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
    case 'median':
      return f64(median(values));
    case 'std':
      return f64(Math.sqrt(variance(values, ddof)));
    case 'var':
      return f64(variance(values, ddof));
    default: {
      if (values.length === 0) throw new PyError('ValueError', `zero-size array to reduction operation ${name === 'min' ? 'minimum' : 'maximum'} which has no identity`);
      if (values.some(Number.isNaN)) return f64(NaN);
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      return typed(name === 'min' ? lo : name === 'max' ? hi : hi - lo);
    }
  }
}

const NUMPY = new Set([
  ...Object.keys(UNARY), ...REDUCTIONS, 'amin', 'amax', 'abs', 'absolute', 'round', 'sign', 'square', 'isfinite', 'isnan', 'isinf', 'arange', 'linspace', 'zeros', 'ones', 'full', 'array', 'asarray', 'where', 'diff', 'cumsum', 'clip',
  'isclose', 'allclose', 'concatenate', 'sort', 'unique', 'hypot', 'maximum', 'minimum', 'quantile', 'percentile', 'any', 'all', 'dot', 'nansum', 'nanmean', 'nanmax', 'nanmin', 'nanmedian', 'count_nonzero', 'argmin', 'argmax', 'argsort', 'float64', 'int64',
]);
const MATH = new Set(['sqrt', 'exp', 'log', 'log10', 'log2', 'sin', 'cos', 'tan', 'floor', 'ceil', 'isfinite', 'isnan', 'isinf', 'fabs', 'hypot', 'pow', 'degrees', 'radians']);
const OS_PATH = new Set(['join', 'basename', 'dirname', 'splitext']);

/** A modelled attribute of a library module, or null when it is not modelled. */
export function libraryAttribute(module: string, attr: string): PyValue | null {
  if (module === 'numpy') {
    if (attr === 'nan' || attr === 'NaN') return pyFloat(NaN);
    if (attr === 'inf') return pyFloat(Infinity);
    if (attr === 'pi') return pyFloat(Math.PI);
    if (attr === 'e') return pyFloat(Math.E);
    if (NUMPY.has(attr)) return { t: 'builtin', name: `numpy.${attr}` };
  }
  if (module === 'math') {
    if (attr === 'pi') return pyFloat(Math.PI);
    if (attr === 'e') return pyFloat(Math.E);
    if (attr === 'inf') return pyFloat(Infinity);
    if (attr === 'nan') return pyFloat(NaN);
    if (MATH.has(attr)) return { t: 'builtin', name: `math.${attr}` };
  }
  if (module === 'os' && attr === 'path') return { t: 'module', name: 'os.path', origin: 'library', modelled: true };
  if (module === 'os.path' && OS_PATH.has(attr)) return { t: 'builtin', name: `os.path.${attr}` };
  if (module === 'pandas' && ['Series', 'DataFrame', 'read_csv', 'isna', 'notna', 'concat'].includes(attr)) return { t: 'builtin', name: `pandas.${attr}` };
  return null;
}

function text(v: PyValue | undefined, fn: string): string {
  if (!v || v.t !== 'str') throw new PyError('TypeError', `${fn}() argument must be str, not ${v ? typeName(v) : 'nothing'}`);
  return v.v;
}

/** Infers the NumPy type of plain Python values. */
export function inferType(items: readonly PyValue[]): DType {
  if (items.length === 0) return 'float64';
  const of = (v: PyValue): DType => (v.t === 'bool' ? 'bool' : v.t === 'int' ? 'int64' : v.t === 'float' ? 'float64' : v.t === 'np-scalar' ? v.dtype : 'object');
  const kinds = new Set(items.map(of));
  if (kinds.has('object')) return 'object';
  if (kinds.size === 1) return [...kinds][0]!;
  return kinds.has('bool') ? 'object' : 'float64';
}

export function toElements(items: readonly PyValue[], dtype: DType): PyValue[] {
  if (dtype === 'object') return [...items];
  return items.map((v) => {
    const n = numericOf(v);
    if (n === null) return no(`Converting ${typeName(v)} to ${dtype}`);
    return { t: 'np-scalar', dtype, v: dtype === 'int64' ? Math.trunc(n) : dtype === 'bool' ? (n !== 0 ? 1 : 0) : n };
  });
}

function dtypeArg(v: PyValue | undefined): DType | null {
  if (!v || v.t === 'none') return null;
  const name = v.t === 'builtin' ? v.name.replace('numpy.', '') : v.t === 'str' ? v.v : '';
  if (name.startsWith('float')) return 'float64';
  if (name.startsWith('int')) return 'int64';
  if (name === 'bool') return 'bool';
  if (name === 'object') return 'object';
  return no(`This dtype`);
}

function onlyKeys(kwargs: Kwargs, allowed: readonly string[], fn: string) {
  for (const k of kwargs.keys()) if (!allowed.includes(k)) no(`\`${k}=\` of ${fn}()`);
}

function flat(v: PyValue, fn: string): readonly PyValue[] {
  if (v.t === 'range') return iterate(v, CAP);
  if (v.t !== 'list' && v.t !== 'tuple' && v.t !== 'ndarray' && v.t !== 'series') return no(`${fn}() of ${typeName(v)}`);
  if (v.items.some((x) => x.t === 'list' || x.t === 'tuple' || x.t === 'ndarray' || x.t === 'series' || x.t === 'dict')) return no(`${fn}() of multi-dimensional data`);
  return v.items;
}

/** Calls a modelled library function by its full name. */
export function callNumeric(name: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  const dot = name.lastIndexOf('.');
  const lib = name.slice(0, dot);
  const fn = name.slice(dot + 1);
  const a = args[0];
  const b = args[1];
  if (lib === 'os.path') {
    onlyKeys(kwargs, [], name);
    if (fn === 'join') {
      let out = text(a, fn);
      for (const part of args.slice(1).map((x) => text(x, fn))) out = part.startsWith('/') ? part : out === '' || out.endsWith('/') ? out + part : `${out}/${part}`;
      return { t: 'str', v: out };
    }
    const p = text(a, fn);
    const cut = p.lastIndexOf('/');
    if (fn === 'basename') return { t: 'str', v: p.slice(cut + 1) };
    if (fn === 'dirname') return { t: 'str', v: cut <= 0 ? (cut === 0 ? '/' : '') : p.slice(0, cut) };
    const ext = /^(.*[^/])(\.[^./]*)$/.exec(p);
    return { t: 'tuple', items: [{ t: 'str', v: ext ? ext[1]! : p }, { t: 'str', v: ext ? ext[2]! : '' }] };
  }
  if (lib === 'math') return callMath(fn, args, kwargs);
  if (lib === 'pandas') return callPandas(fn, args, kwargs);
  if (lib !== 'numpy' || !a) return no(`${name}()`);

  if (UNARY[fn]) {
    onlyKeys(kwargs, [], name);
    return mapNums(a, name, UNARY[fn]!, 'float64');
  }
  if (REDUCTIONS.includes(fn) || fn === 'amin' || fn === 'amax') {
    onlyKeys(kwargs, fn === 'std' || fn === 'var' ? ['ddof'] : [], name);
    if (args.length > 1) return no(`${name}() with an axis`);
    if (a.t === 'dataframe') return no(`${name}() of a table`);
    if (a.t === 'series' && a.items.some((x) => Number.isNaN(numericOf(x) ?? 0))) return no(`${name}() of a Series with missing values`);
    return reduceNums(fn.replace(/^a(min|max)$/, '$1'), nums(a, name), allInt(a), numericOf(kwargs.get('ddof') ?? pyInt(0)) ?? 0);
  }
  switch (fn) {
    case 'float64':
      return f64(numericOf(a) ?? no('This conversion'));
    case 'int64':
      return i64(Math.trunc(numericOf(a) ?? no('This conversion')));
    case 'abs':
    case 'absolute':
      return mapNums(a, name, Math.abs, allInt(a) ? 'int64' : 'float64');
    case 'square':
      return mapNums(a, name, (x) => x * x, allInt(a) ? 'int64' : 'float64');
    case 'sign':
      return mapNums(a, name, Math.sign, allInt(a) ? 'int64' : 'float64');
    case 'round': {
      const d = numericOf(b ?? kwargs.get('decimals') ?? pyInt(0)) ?? 0;
      return mapNums(a, name, (x) => roundEven(x, d), allInt(a) ? 'int64' : 'float64');
    }
    case 'isfinite':
      return mapNums(a, name, (x) => (Number.isFinite(x) ? 1 : 0), 'bool');
    case 'isnan':
      return mapNums(a, name, (x) => (Number.isNaN(x) ? 1 : 0), 'bool');
    case 'isinf':
      return mapNums(a, name, (x) => (Math.abs(x) === Infinity ? 1 : 0), 'bool');
    case 'arange': {
      onlyKeys(kwargs, [], name);
      const [start, stop, step] = args.length === 1 ? [0, nOf(a), 1] : [nOf(a), nOf(b!), args[2] ? nOf(args[2]) : 1];
      const n = Math.max(0, Math.ceil((stop - start) / step));
      if (n > CAP) return no('An array this long');
      return arr(Array.from({ length: n }, (_, i) => start + i * step), args.every(allInt) ? 'int64' : 'float64');
    }
    case 'linspace': {
      onlyKeys(kwargs, ['num'], name);
      const n = args[2] || kwargs.get('num') ? nOf((args[2] ?? kwargs.get('num'))!) : 50;
      const lo = nOf(a);
      const hi = nOf(b!);
      if (n > CAP) return no('An array this long');
      return arr(Array.from({ length: n }, (_, i) => (i === n - 1 && n > 1 ? hi : lo + (i * (hi - lo)) / Math.max(1, n - 1))), 'float64');
    }
    case 'zeros':
    case 'ones':
    case 'full': {
      const n = a.t === 'int' ? a.v : no(`${name}() with more than one dimension`);
      const fill = fn === 'zeros' ? 0 : fn === 'ones' ? 1 : nOf(b!);
      const dtype = dtypeArg(kwargs.get('dtype') ?? args[fn === 'full' ? 2 : 1]) ?? (fn === 'full' && allInt(b!) ? 'int64' : 'float64');
      if (n > CAP) return no('An array this long');
      return arr(Array.from({ length: n }, () => fill), dtype);
    }
    case 'array':
    case 'asarray': {
      onlyKeys(kwargs, ['dtype'], name);
      const items = flat(a, name);
      const dtype = dtypeArg(kwargs.get('dtype') ?? b) ?? (isArray(a) ? a.dtype : inferType(items));
      return { t: 'ndarray', dtype, items: toElements(items, dtype) };
    }
    case 'where': {
      if (args.length !== 3 || !isArray(a)) return no('np.where in this form');
      const pick = (src: PyValue, i: number) => (isArray(src) ? src.items[i]! : src);
      const items = a.items.map((c, i) => pick(numericOf(c) ? args[1]! : args[2]!, i));
      const dtype = inferType(items);
      return { t: 'ndarray', dtype, items: toElements(items, dtype) };
    }
    case 'diff': {
      onlyKeys(kwargs, [], name);
      if (args.length > 1) return no('np.diff of higher order');
      const v = nums(a, name);
      return arr(v.slice(1).map((x, i) => x - v[i]!), allInt(a) ? 'int64' : 'float64');
    }
    case 'cumsum': {
      let t = 0;
      const out = nums(a, name).map((x) => (t += x));
      return withItems(a, arr(out, allInt(a) ? 'int64' : 'float64').items, allInt(a) ? 'int64' : 'float64');
    }
    case 'clip': {
      const lo = b && b.t !== 'none' ? nOf(b) : -Infinity;
      const hi = args[2] && args[2].t !== 'none' ? nOf(args[2]) : Infinity;
      return mapNums(a, name, (x) => Math.min(Math.max(x, lo), hi), args.slice(0, 3).every((x) => allInt(x) || x.t === 'none') ? 'int64' : 'float64');
    }
    case 'concatenate': {
      onlyKeys(kwargs, [], name);
      const items = iterate(a, CAP).flatMap((x) => [...flat(x, name)]);
      const dtype = inferType(items);
      return { t: 'ndarray', dtype, items: toElements(items, dtype) };
    }
    case 'sort':
      return arr([...nums(a, name)].sort((x, y) => x - y), allInt(a) ? 'int64' : 'float64');
    case 'argsort':
      return arr(nums(a, name).map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1]).map((p) => p[1]), 'int64');
    case 'unique': {
      onlyKeys(kwargs, [], name);
      return arr([...new Set(nums(a, name))].sort((x, y) => x - y), allInt(a) ? 'int64' : 'float64');
    }
    case 'isclose':
    case 'allclose': {
      onlyKeys(kwargs, ['rtol', 'atol'], name);
      const rtol = kwargs.get('rtol') ? nOf(kwargs.get('rtol')!) : 1e-5;
      const atol = kwargs.get('atol') ? nOf(kwargs.get('atol')!) : 1e-8;
      if (!b) return no(`${name}() without a second value`);
      const close = (x: number, y: number) => x === y || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= atol + rtol * Math.abs(y));
      if (!isArray(a) && !isArray(b)) {
        const yes = close(nOf(a), nOf(b));
        return fn === 'allclose' ? { t: 'bool', v: yes } : { t: 'np-scalar', dtype: 'bool', v: yes ? 1 : 0 };
      }
      const like = (isArray(a) ? a : b) as Series | NdArray;
      const at = (v: PyValue, i: number) => (isArray(v) ? nOf(v.items[i] ?? no('Arrays of different length')) : nOf(v));
      if (isArray(a) && isArray(b) && a.items.length !== b.items.length) return no('Arrays of different length');
      const flags = like.items.map((_, i) => close(at(a, i), at(b, i)));
      if (fn === 'allclose') return { t: 'bool', v: flags.every(Boolean) };
      return arr(flags.map(Number), 'bool');
    }
    case 'hypot':
    case 'maximum':
    case 'minimum': {
      const op = fn === 'hypot' ? Math.hypot : fn === 'maximum' ? Math.max : Math.min;
      const dtype = fn !== 'hypot' && allInt(a) && allInt(b!) ? 'int64' : 'float64';
      if (!isArray(a) && !isArray(b!)) return dtype === 'int64' ? i64(op(nOf(a), nOf(b!))) : f64(op(nOf(a), nOf(b!)));
      const like = isArray(a) ? a : (b as Series | NdArray);
      const at = (v: PyValue, i: number) => (isArray(v) ? nOf(v.items[i] ?? no('Arrays of different length')) : nOf(v));
      return withItems(like, like.items.map((_, i) => ({ t: 'np-scalar', dtype: dtype as 'float64' | 'int64', v: op(at(a, i), at(b!, i)) }) as PyValue), dtype);
    }
    case 'quantile':
    case 'percentile': {
      onlyKeys(kwargs, [], name);
      const scale = fn === 'percentile' ? 100 : 1;
      const v = nums(a, name);
      if (isArray(b!) || b!.t === 'list' || b!.t === 'tuple') return arr(nums(b!, name).map((q) => quantile(v, q / scale)), 'float64');
      return f64(quantile(v, nOf(b!) / scale));
    }
    case 'any':
      return nbool(nums(a, name).some((x) => x !== 0));
    case 'all':
      return nbool(nums(a, name).every((x) => x !== 0));
    case 'count_nonzero':
      return pyInt(nums(a, name).filter((x) => x !== 0).length);
    case 'argmin':
    case 'argmax': {
      const v = nums(a, name);
      if (v.length === 0) throw new PyError('ValueError', `attempt to get ${fn} of an empty sequence`);
      if (v.some(Number.isNaN)) return i64(v.findIndex(Number.isNaN));
      return i64(v.indexOf(fn === 'argmin' ? Math.min(...v) : Math.max(...v)));
    }
    case 'dot': {
      const x = nums(a, name);
      const y = nums(b!, name);
      if (x.length !== y.length) return no('np.dot of these shapes');
      return (allInt(a) && allInt(b!) ? i64 : f64)(x.reduce((t, v, i) => t + v * y[i]!, 0));
    }
    case 'nansum':
    case 'nanmean':
    case 'nanmax':
    case 'nanmin':
    case 'nanmedian':
      return reduceNums(fn.slice(3), nums(a, name).filter((x) => !Number.isNaN(x)), allInt(a), 0);
    default:
      return no(`${name}()`);
  }
}

function nOf(v: PyValue): number {
  const n = numericOf(v);
  return n === null ? no(`A number from ${typeName(v)}`) : n;
}

function mapNums(v: PyValue, what: string, f: (x: number) => number, dtype: 'float64' | 'int64' | 'bool'): PyValue {
  const scalar = numericOf(v);
  if (scalar !== null) return { t: 'np-scalar', dtype, v: f(scalar) };
  const items = nums(v, what).map((x): PyValue => ({ t: 'np-scalar', dtype, v: f(x) }));
  return withItems(v, items, dtype);
}

function callMath(fn: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  if (kwargs.size > 0) return no(`math.${fn}() with keywords`);
  const x = numericOf(args[0] ?? pyInt(0));
  if (x === null) throw new PyError('TypeError', `must be real number, not ${typeName(args[0]!)}`);
  const y = args[1] ? nOf(args[1]) : undefined;
  const domain = () => {
    throw new PyError('ValueError', 'math domain error');
  };
  switch (fn) {
    case 'sqrt':
      if (x < 0) domain();
      return pyFloat(Math.sqrt(x));
    case 'log':
      if (x <= 0) domain();
      return pyFloat(y === undefined ? Math.log(x) : Math.log(x) / Math.log(y));
    case 'log10':
    case 'log2':
      if (x <= 0) domain();
      return pyFloat(fn === 'log10' ? Math.log10(x) : Math.log2(x));
    case 'floor':
    case 'ceil':
      return pyInt(fn === 'floor' ? Math.floor(x) : Math.ceil(x));
    case 'isfinite':
      return { t: 'bool', v: Number.isFinite(x) };
    case 'isnan':
      return { t: 'bool', v: Number.isNaN(x) };
    case 'isinf':
      return { t: 'bool', v: Math.abs(x) === Infinity };
    case 'fabs':
      return pyFloat(Math.abs(x));
    case 'hypot':
      return pyFloat(Math.hypot(x, y ?? 0));
    case 'pow':
      return pyFloat(x ** (y ?? 1));
    case 'degrees':
      return pyFloat((x * 180) / Math.PI);
    case 'radians':
      return pyFloat((x * Math.PI) / 180);
    case 'exp':
      return pyFloat(Math.exp(x));
    case 'sin':
      return pyFloat(Math.sin(x));
    case 'cos':
      return pyFloat(Math.cos(x));
    case 'tan':
      return pyFloat(Math.tan(x));
    default:
      return no(`math.${fn}()`);
  }
}

// ---- pandas ------------------------------------------------------------------------

const labels = (v: Series | DataFrame): number[] => {
  const n = v.t === 'series' ? v.items.length : v.columns[0]?.items.length ?? 0;
  return v.index ? [...v.index] : Array.from({ length: n }, (_, i) => i);
};

export const rowsOf = (df: DataFrame): number => df.columns[0]?.items.length ?? 0;

/** Keeps the given row positions, remembering their labels. */
export function takeRows<T extends Series | DataFrame>(v: T, at: readonly number[]): T {
  const idx = labels(v);
  const index = at.map((i) => idx[i]!);
  const plain = index.every((l, i) => l === i);
  const keep = plain ? {} : { index };
  if (v.t === 'series') return { t: 'series', dtype: v.dtype, items: at.map((i) => v.items[i]!), ...(v.name !== undefined ? { name: v.name } : {}), ...keep } as unknown as T;
  return { t: 'dataframe', columns: v.columns.map((c) => ({ ...c, items: at.map((i) => c.items[i]!) })), ...keep } as unknown as T;
}

const missing = (v: PyValue): boolean => v.t === 'none' || ((v.t === 'float' || v.t === 'np-scalar') && Number.isNaN(v.v));

export function columnOf(df: DataFrame, name: string): Series {
  const c = df.columns.find((x) => x.name === name);
  if (!c) throw new PyError('KeyError', `'${name}'`);
  return { t: 'series', dtype: c.dtype, items: c.items, name, ...(df.index ? { index: df.index } : {}) };
}

/** `df[name] = value` for a scalar, a list/array, or a Series with the same row labels. */
export function setColumn(df: DataFrame, name: string, value: PyValue): DataFrame {
  const n = rowsOf(df);
  let items: PyValue[];
  if (isArray(value) || value.t === 'list') {
    if (value.items.length !== n && df.columns.length > 0) throw new PyError('ValueError', `Length of values (${value.items.length}) does not match length of index (${n})`);
    if (value.t === 'series' && labels(value).join() !== labels(df).join()) return no('Adding a column with different row labels');
    items = [...value.items];
  } else if (['int', 'float', 'str', 'bool', 'none', 'np-scalar'].includes(value.t)) items = Array.from({ length: n }, () => value);
  else return no(`A column from ${typeName(value)}`);
  const dtype = value.t === 'series' || value.t === 'ndarray' ? value.dtype : inferType(items);
  const col = { name, dtype, items: toElements(items, dtype) };
  const at = df.columns.findIndex((c) => c.name === name);
  const columns = at >= 0 ? df.columns.map((c, i) => (i === at ? col : c)) : [...df.columns, col];
  return { ...df, columns };
}

/** True/False for each row of a boolean mask. */
export function maskPositions(mask: PyValue, n: number): number[] | null {
  if (!(isArray(mask) || mask.t === 'list') || mask.items.length !== n) return null;
  if (mask.t !== 'list' && mask.dtype !== 'bool') return null;
  if (!mask.items.every((v) => v.t === 'bool' || (v.t === 'np-scalar' && v.dtype === 'bool'))) return null;
  return mask.items.flatMap((v, i) => (numericOf(v) ? [i] : []));
}

function tableFromRows(rows: readonly PyValue[]): DataFrame {
  const names: string[] = [];
  for (const r of rows) {
    if (r.t !== 'dict') return no('A table from this list');
    for (const [k] of r.entries) if (k.t !== 'str') return no('A table with non-text column names');
      else if (!names.includes(k.v)) names.push(k.v);
  }
  return {
    t: 'dataframe',
    columns: names.map((name) => {
      const items = rows.map((r) => (r as Extract<PyValue, { t: 'dict' }>).entries.find(([k]) => k.t === 'str' && k.v === name)?.[1] ?? pyFloat(NaN));
      return makeColumn(name, items);
    }),
  };
}

function makeColumn(name: string, raw: readonly PyValue[]) {
  // pandas turns None into NaN in a column of numbers.
  const numeric = raw.some((v) => numericOf(v) !== null) && raw.every((v) => v.t === 'none' || (numericOf(v) !== null && v.t !== 'bool'));
  const items = numeric ? raw.map((v) => (v.t === 'none' ? pyFloat(NaN) : v)) : raw;
  if (items.some((v) => v.t === 'unknown')) throw new UnsupportedError('A table with values that are not known is not computed.');
  const dtype = inferType(items);
  return { name, dtype, items: toElements(items, dtype) };
}

function callPandas(fn: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  const a = args[0];
  switch (fn) {
    case 'Series': {
      onlyKeys(kwargs, ['dtype', 'name'], 'pandas.Series');
      if (!a) return no('An empty Series');
      const items = flat(a, 'pandas.Series');
      const dtype = dtypeArg(kwargs.get('dtype')) ?? (isArray(a) ? a.dtype : inferType(items));
      const name = kwargs.get('name');
      return { t: 'series', dtype, items: toElements(items, dtype), ...(name?.t === 'str' ? { name: name.v } : a.t === 'series' && a.name !== undefined ? { name: a.name } : {}), ...(a.t === 'series' && a.index ? { index: a.index } : {}) };
    }
    case 'DataFrame': {
      onlyKeys(kwargs, ['columns'], 'pandas.DataFrame');
      if (kwargs.size > 0) return no('pandas.DataFrame with columns=');
      if (!a) return { t: 'dataframe', columns: [] };
      if (a.t === 'dataframe') return { ...a };
      if (a.t === 'list') return a.items.length === 0 ? { t: 'dataframe', columns: [] } : tableFromRows(a.items);
      if (a.t === 'dict') {
        const cols = a.entries.map(([k, v]) => {
          if (k.t !== 'str') return no('A table with non-text column names');
          if (v.t === 'series' && v.index) return no('A table from filtered Series');
          return makeColumn(k.v, flat(v, 'pandas.DataFrame'));
        });
        if (new Set(cols.map((c) => c.items.length)).size > 1) throw new PyError('ValueError', 'All arrays must be of the same length');
        return { t: 'dataframe', columns: cols };
      }
      return no(`A table from ${typeName(a)}`);
    }
    case 'isna':
    case 'notna': {
      if (!a) return no('pandas.isna()');
      if (a.t === 'series') return callSeries(a, fn, [], new Map());
      if (['int', 'float', 'str', 'bool', 'none', 'np-scalar'].includes(a.t)) return { t: 'bool', v: missing(a) === (fn === 'isna') };
      return no(`pandas.${fn}() of ${typeName(a)}`);
    }
    default:
      return no(`pandas.${fn}()`);
  }
}

const SERIES_METHODS = new Set([
  'to_numpy', 'tolist', 'to_list', 'sum', 'mean', 'median', 'std', 'var', 'min', 'max', 'prod', 'count', 'abs', 'round', 'diff', 'cumsum', 'shift', 'dropna', 'fillna', 'isna', 'isnull', 'notna', 'notnull', 'unique', 'nunique', 'isin',
  'between', 'astype', 'head', 'tail', 'sort_values', 'any', 'all', 'copy', 'reset_index', 'clip', 'quantile', 'eq', 'ne', 'gt', 'lt', 'ge', 'le', 'add', 'sub', 'mul', 'div',
]);
const ARRAY_METHODS = new Set(['sum', 'mean', 'std', 'var', 'min', 'max', 'prod', 'tolist', 'any', 'all', 'copy', 'astype', 'round', 'cumsum', 'argmin', 'argmax', 'item', 'ravel', 'clip']);
const FRAME_METHODS = new Set(['head', 'tail', 'copy', 'dropna', 'reset_index', 'sort_values', 'assign', 'rename', 'drop', 'isna', 'get']);

export function hasNumericMethod(v: PyValue, name: string): boolean {
  return v.t === 'series' ? SERIES_METHODS.has(name) : v.t === 'ndarray' ? ARRAY_METHODS.has(name) : v.t === 'dataframe' ? FRAME_METHODS.has(name) : false;
}

export function callNumericMethod(self: PyValue, name: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  if (self.t === 'series') return callSeries(self, name, args, kwargs);
  if (self.t === 'ndarray') return callArray(self, name, args, kwargs);
  if (self.t === 'dataframe') return callFrame(self, name, args, kwargs);
  return no(`.${name}()`);
}

function toPython(v: PyValue): PyValue {
  return v.t === 'np-scalar' ? (v.dtype === 'float64' ? pyFloat(v.v) : v.dtype === 'bool' ? { t: 'bool', v: v.v !== 0 } : pyInt(v.v)) : v;
}

function callArray(self: NdArray, name: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  switch (name) {
    case 'tolist':
      return { t: 'list', items: self.items.map(toPython) };
    case 'copy':
    case 'ravel':
      return self;
    case 'item':
      if (self.items.length !== 1) throw new PyError('ValueError', 'can only convert an array of size 1 to a Python scalar');
      return toPython(self.items[0]!);
    case 'astype': {
      const dtype = dtypeArg(args[0])!;
      return { t: 'ndarray', dtype, items: toElements(self.items, dtype) };
    }
    default:
      return callNumeric(`numpy.${name}`, [self, ...args], kwargs);
  }
}

const COMPARE: Record<string, string> = { eq: '==', ne: '!=', gt: '>', lt: '<', ge: '>=', le: '<=' };
const ARITH: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/' };

function callSeries(self: Series, name: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  const same = (items: readonly PyValue[], dtype: DType): PyValue => ({ ...self, items, dtype });
  const flags = (f: (v: PyValue) => boolean) => same(self.items.map((v) => nbool(f(v))), 'bool');
  const isInt = self.dtype === 'int64' || self.dtype === 'bool';
  const a = args[0];
  const present = () => nums(self, `.${name}()`).filter((x) => !Number.isNaN(x));
  if (COMPARE[name]) return compareArrays(COMPARE[name]!, self, a!);
  if (ARITH[name]) return binaryOp(ARITH[name]!, self, a!);
  switch (name) {
    case 'to_numpy': {
      onlyKeys(kwargs, ['dtype'], name);
      const dtype = dtypeArg(kwargs.get('dtype') ?? a) ?? self.dtype;
      return { t: 'ndarray', dtype, items: toElements(self.items, dtype) };
    }
    case 'tolist':
    case 'to_list':
      return { t: 'list', items: self.items.map(toPython) };
    case 'sum':
    case 'mean':
    case 'median':
    case 'min':
    case 'max':
    case 'prod':
    case 'std':
    case 'var': {
      onlyKeys(kwargs, name === 'std' || name === 'var' ? ['ddof'] : [], name);
      if (args.length > 0) return no(`.${name}() with arguments`);
      if (present().length === 0 && (name === 'min' || name === 'max')) return f64(NaN);
      return reduceNums(name, present(), isInt, numericOf(kwargs.get('ddof') ?? pyInt(1)) ?? 1);
    }
    case 'count':
      return i64(self.items.filter((v) => !missing(v)).length);
    case 'abs':
      return mapNums(self, '.abs()', Math.abs, isInt ? 'int64' : 'float64');
    case 'round': {
      const d = numericOf(a ?? kwargs.get('decimals') ?? pyInt(0)) ?? 0;
      return mapNums(self, '.round()', (x) => roundEven(x, d), isInt ? 'int64' : 'float64');
    }
    case 'clip': {
      const lo = a ?? kwargs.get('lower');
      const hi = args[1] ?? kwargs.get('upper');
      return mapNums(self, '.clip()', (x) => Math.min(Math.max(x, lo && lo.t !== 'none' ? nOf(lo) : -Infinity), hi && hi.t !== 'none' ? nOf(hi) : Infinity), 'float64');
    }
    case 'diff': {
      if (args.length > 0 || kwargs.size > 0) return no('.diff() with arguments');
      const v = nums(self, '.diff()');
      return same(v.map((x, i) => f64(i === 0 ? NaN : x - v[i - 1]!)), 'float64');
    }
    case 'shift': {
      onlyKeys(kwargs, [], name);
      const k = a ? nOf(a) : 1;
      const v = nums(self, '.shift()');
      return same(v.map((_, i) => f64(v[i - k] ?? NaN)), 'float64');
    }
    case 'cumsum': {
      let t = 0;
      const v = nums(self, '.cumsum()').map((x) => (Number.isNaN(x) ? NaN : (t += x)));
      return same(v.map(isInt ? i64 : f64), isInt ? 'int64' : 'float64');
    }
    case 'dropna':
      onlyKeys(kwargs, [], name);
      return takeRows(self, self.items.flatMap((v, i) => (missing(v) ? [] : [i])));
    case 'fillna': {
      onlyKeys(kwargs, [], name);
      const items = self.items.map((v) => (missing(v) ? a! : v));
      const dtype = inferType(items);
      return same(toElements(items, dtype), dtype);
    }
    case 'isna':
    case 'isnull':
      return flags(missing);
    case 'notna':
    case 'notnull':
      return flags((v) => !missing(v));
    case 'unique': {
      const out: PyValue[] = [];
      for (const v of self.items) if (!out.some((o) => pyEquals(o, v) || (missing(o) && missing(v)))) out.push(v);
      return { t: 'ndarray', dtype: self.dtype, items: out };
    }
    case 'nunique': {
      const out: PyValue[] = [];
      for (const v of self.items) if (!missing(v) && !out.some((o) => pyEquals(o, v))) out.push(v);
      return pyInt(out.length);
    }
    case 'isin': {
      const set = iterate(a!, CAP);
      return flags((v) => set.some((o) => pyEquals(o, v)));
    }
    case 'between': {
      onlyKeys(kwargs, [], name);
      const lo = nOf(a!);
      const hi = nOf(args[1]!);
      return flags((v) => nOf(v) >= lo && nOf(v) <= hi);
    }
    case 'astype': {
      const dtype = dtypeArg(a)!;
      return same(toElements(self.items, dtype), dtype);
    }
    case 'head':
    case 'tail': {
      const n = a ? nOf(a) : 5;
      const size = self.items.length;
      const all = Array.from({ length: size }, (_, i) => i);
      return takeRows(self, name === 'head' ? all.slice(0, n) : all.slice(Math.max(0, size - n)));
    }
    case 'sort_values': {
      onlyKeys(kwargs, ['ascending'], name);
      const asc = kwargs.get('ascending');
      const v = nums(self, '.sort_values()');
      if (v.some(Number.isNaN) || new Set(v).size < v.length) return no('.sort_values() with ties or missing values');
      const at = v.map((_, i) => i).sort((p, q) => (asc?.t === 'bool' && !asc.v ? v[q]! - v[p]! : v[p]! - v[q]!));
      return takeRows(self, at);
    }
    case 'reset_index': {
      const drop = kwargs.get('drop');
      if (!(drop?.t === 'bool' && drop.v)) return no('.reset_index() without drop=True');
      const { index: _index, ...rest } = self;
      return rest;
    }
    case 'any':
      return nbool(present().some((x) => x !== 0));
    case 'all':
      return nbool(present().every((x) => x !== 0));
    case 'quantile': {
      onlyKeys(kwargs, [], name);
      return f64(quantile(present(), a ? nOf(a) : 0.5));
    }
    case 'copy':
      return { ...self };
    default:
      return no(`Series.${name}()`);
  }
}

function callFrame(self: DataFrame, name: string, args: readonly PyValue[], kwargs: Kwargs): PyValue {
  const n = rowsOf(self);
  const all = Array.from({ length: n }, (_, i) => i);
  const { ref: _ref, ...fresh } = self;
  switch (name) {
    case 'head':
    case 'tail': {
      onlyKeys(kwargs, ['n'], name);
      const arg = args[0] ?? kwargs.get('n');
      const k = arg ? nOf(arg) : 5;
      const size = k >= 0 ? k : Math.max(0, n + k);
      return takeRows(fresh, name === 'head' ? all.slice(0, size) : all.slice(Math.max(0, n - size)));
    }
    case 'copy':
      return fresh;
    case 'get': {
      const key = args[0];
      if (key?.t !== 'str') return no('.get() of a table');
      return self.columns.some((c) => c.name === key.v) ? columnOf(self, key.v) : args[1] ?? { t: 'none' };
    }
    case 'dropna': {
      onlyKeys(kwargs, ['subset'], name);
      const subset = kwargs.get('subset');
      const names = subset ? iterate(subset, 100).map((v) => (v.t === 'str' ? v.v : no('This subset'))) : self.columns.map((c) => c.name);
      const cols = names.map((x) => columnOf(self, x).items);
      return takeRows(fresh, all.filter((i) => cols.every((c) => !missing(c[i]!))));
    }
    case 'reset_index': {
      const drop = kwargs.get('drop');
      if (!(drop?.t === 'bool' && drop.v) || kwargs.size > 1) return no('.reset_index() without drop=True');
      const { index: _index, ...rest } = fresh;
      return rest;
    }
    case 'sort_values': {
      onlyKeys(kwargs, ['ascending', 'by'], name);
      const by = args[0] ?? kwargs.get('by');
      if (by?.t !== 'str') return no('.sort_values() by several columns');
      const sorted = callSeries({ ...columnOf(self, by.v), index: all }, 'sort_values', [], new Map([...kwargs].filter(([k]) => k === 'ascending'))) as Series;
      return takeRows(fresh, sorted.index ?? all);
    }
    case 'assign': {
      if (args.length > 0) return no('.assign() in this form');
      let out: DataFrame = fresh;
      for (const [k, v] of kwargs) out = setColumn(out, k, v);
      return out;
    }
    case 'rename': {
      onlyKeys(kwargs, ['columns'], name);
      const map = kwargs.get('columns');
      if (map?.t !== 'dict') return no('.rename() in this form');
      const to = (c: string) => {
        const hit = map.entries.find(([k]) => k.t === 'str' && k.v === c)?.[1];
        return hit ? (hit.t === 'str' ? hit.v : no('This new column name')) : c;
      };
      return { ...fresh, columns: self.columns.map((c) => ({ ...c, name: to(c.name) })) };
    }
    case 'drop': {
      onlyKeys(kwargs, ['columns'], name);
      const cols = kwargs.get('columns');
      if (!cols || args.length > 0) return no('.drop() of rows');
      const gone = (cols.t === 'str' ? [cols] : iterate(cols, 1000)).map((v) => (v.t === 'str' ? v.v : no('This column name')));
      for (const g of gone) columnOf(self, g);
      return { ...fresh, columns: self.columns.filter((c) => !gone.includes(c.name)) };
    }
    case 'isna':
      return { ...fresh, columns: self.columns.map((c) => ({ name: c.name, dtype: 'bool' as DType, items: c.items.map((v) => nbool(missing(v))) })) };
    default:
      return no(`DataFrame.${name}()`);
  }
}

/** Element-wise comparison of arrays / Series (gives True/False per element). */
export function compareArrays(op: string, a: PyValue, b: PyValue): PyValue {
  const like = isArray(a) ? a : isArray(b) ? b : no('This comparison');
  if (isArray(a) && isArray(b)) {
    if (a.items.length !== b.items.length) return no('Comparing arrays of different length');
    if (a.t === 'series' && b.t === 'series' && labels(a).join() !== labels(b).join()) throw new PyError('ValueError', 'Can only compare identically-labeled Series objects');
  }
  const at = (v: PyValue, i: number) => (isArray(v) ? v.items[i]! : v);
  return withItems(
    like,
    like.items.map((_, i) => nbool(compareOp(op, at(a, i), at(b, i)))),
    'bool',
  );
}

/** `&`, `|`, `^` and `~` on True/False arrays. */
export function logicArrays(op: string, a: PyValue, b: PyValue | null): PyValue {
  const like = isArray(a) ? a : b && isArray(b) ? b : no(`\`${op}\` here`);
  const at = (v: PyValue, i: number): boolean => {
    const x = isArray(v) ? v.items[i]! : v;
    if (!(x.t === 'bool' || (x.t === 'np-scalar' && x.dtype === 'bool'))) return no(`\`${op}\` on non-boolean data`);
    return numericOf(x) !== 0;
  };
  if (b && isArray(a) && isArray(b) && a.items.length !== b.items.length) return no(`\`${op}\` on arrays of different length`);
  return withItems(
    like,
    like.items.map((_, i) => nbool(op === '~' ? !at(a, i) : op === '&' ? at(a, i) && at(b!, i) : op === '|' ? at(a, i) || at(b!, i) : at(a, i) !== at(b!, i))),
    'bool',
  );
}
