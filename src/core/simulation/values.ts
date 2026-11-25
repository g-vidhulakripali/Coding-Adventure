import type { FunctionDef } from '../parser/python/ast';

/**
 * Values in the controlled simulation.
 *
 * These model a small, explicit subset of Python, NumPy and pandas. They are
 * NOT Python objects: they exist so each step can show the value entering and
 * leaving an operation. Anything outside this model stops the simulation with
 * an "unsupported" step instead of being guessed.
 */

export type DType = 'float64' | 'int64' | 'bool' | 'object';

/** Variable scopes a nested function or lambda can see, innermost first. */
export type Closure = ReadonlyArray<Map<string, { value: PyValue; setAt: number | null }>>;

export interface FunctionValue {
  readonly closure?: Closure;
  readonly def: FunctionDef;
  /** File that defines the function; also its global namespace. */
  readonly path: string;
  readonly qualname: string;
}

export type PyValue =
  | { readonly t: 'none' }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'int'; readonly v: number }
  | { readonly t: 'float'; readonly v: number }
  | { readonly t: 'str'; readonly v: string }
  /** `ref` identifies a mutable container, so every name holding it sees the same changes. */
  | { readonly t: 'list'; readonly items: readonly PyValue[]; readonly ref?: number }
  | { readonly t: 'set'; readonly items: readonly PyValue[]; readonly ref?: number }
  /** A value the simulation cannot compute. Shown as `?`, never guessed. `from` is the code or library name it comes from. */
  | { readonly t: 'unknown'; readonly from: string }
  | { readonly t: 'exc-type'; readonly name: string }
  | { readonly t: 'exception'; readonly name: string; readonly message: string }
  | { readonly t: 'ellipsis' }
  | { readonly t: 'tuple'; readonly items: readonly PyValue[] }
  | { readonly t: 'dict'; readonly entries: ReadonlyArray<readonly [PyValue, PyValue]>; readonly ref?: number }
  | { readonly t: 'range'; readonly start: number; readonly stop: number; readonly step: number }
  | { readonly t: 'function'; readonly fn: FunctionValue }
  | { readonly t: 'builtin'; readonly name: string }
  | { readonly t: 'class'; readonly name: string; readonly path: string }
  | { readonly t: 'module'; readonly name: string; readonly origin: 'project' | 'library'; readonly modelled: boolean; readonly path?: string }
  | { readonly t: 'np-scalar'; readonly dtype: 'float64' | 'int64' | 'bool'; readonly v: number }
  | { readonly t: 'ndarray'; readonly dtype: DType; readonly items: readonly PyValue[] }
  | { readonly t: 'series'; readonly dtype: DType; readonly items: readonly PyValue[]; readonly name?: string; /** Row labels when they differ from 0…n-1. */ readonly index?: readonly number[] }
  | { readonly t: 'iloc'; readonly series: Extract<PyValue, { t: 'series' }> }
  | { readonly t: 'method'; readonly self: PyValue; readonly name: string; readonly owner: string }
  /**
   * An object made from a project class. `id` identifies it in the simulation's object store;
   * `fields` is a snapshot of its attributes at the moment the value was recorded.
   */
  | { readonly t: 'instance'; readonly id: number; readonly cls: string; readonly fields: ReadonlyArray<readonly [string, PyValue]> }
  /** A project method bound to its object (`obj.load`), ready to be called. */
  | { readonly t: 'bound'; readonly self: PyValue; readonly fn: FunctionValue; readonly cls: string }
  /** A pandas DataFrame: named columns of equal length (default RangeIndex). */
  | { readonly t: 'dataframe'; readonly columns: ReadonlyArray<{ readonly name: string; readonly dtype: DType; readonly items: readonly PyValue[] }>; readonly ref?: number; readonly index?: readonly number[] };

export const NONE: PyValue = { t: 'none' };
export const unknown = (from: string): PyValue => ({ t: 'unknown', from });
export const isUnknown = (v: PyValue): boolean => v.t === 'unknown';
export const pyInt = (v: number): PyValue => ({ t: 'int', v });
export const pyFloat = (v: number): PyValue => ({ t: 'float', v });
export const pyStr = (v: string): PyValue => ({ t: 'str', v });
export const pyBool = (v: boolean): PyValue => ({ t: 'bool', v });

/** Python-style type name, as `type(x).__name__` (qualified for library types). */
export function typeName(value: PyValue): string {
  switch (value.t) {
    case 'none':
      return 'NoneType';
    case 'unknown':
      return 'not computed';
    case 'exc-type':
      return 'type';
    case 'exception':
      return value.name;
    case 'np-scalar':
      return `numpy.${value.dtype === 'bool' ? 'bool' : value.dtype}`;
    case 'ndarray':
      return 'numpy.ndarray';
    case 'series':
      return 'pandas.Series';
    case 'iloc':
      return 'pandas indexer (.iloc)';
    case 'instance':
      return value.cls;
    case 'bound':
      return 'method';
    case 'dataframe':
      return 'pandas.DataFrame';
    case 'method':
      return 'method';
    case 'builtin':
      return 'builtin_function_or_method';
    case 'class':
      return 'type';
    default:
      return value.t;
  }
}

/** Short type label including dtype where it matters, e.g. `numpy.ndarray[float64]`. */
export function typeLabel(value: PyValue): string {
  if (value.t === 'dataframe') return `pandas.DataFrame (${dataframeRows(value)}×${value.columns.length})`;
  if (value.t === 'ndarray' || value.t === 'series') return `${typeName(value)} (${value.dtype})`;
  return typeName(value);
}

export function isCollection(value: PyValue): value is Extract<PyValue, { t: 'list' | 'tuple' | 'ndarray' | 'series' }> {
  return value.t === 'list' || value.t === 'tuple' || value.t === 'ndarray' || value.t === 'series';
}

/** True when the value is, or directly contains, something that could not be computed. */
export function hasUnknown(value: PyValue, depth = 3): boolean {
  if (value.t === 'unknown') return true;
  if (depth === 0) return false;
  switch (value.t) {
    case 'list':
    case 'tuple':
    case 'set':
      return value.items.some((v) => hasUnknown(v, depth - 1));
    case 'dict':
      return value.entries.some(([k, v]) => hasUnknown(k, depth - 1) || hasUnknown(v, depth - 1));
    default:
      return false;
  }
}

/** Numeric view for int/float/bool/np-scalar; null otherwise. */
export function numericOf(value: PyValue): number | null {
  switch (value.t) {
    case 'int':
    case 'float':
    case 'np-scalar':
      return value.v;
    case 'bool':
      return value.v ? 1 : 0;
    default:
      return null;
  }
}

// ---- Python-style text --------------------------------------------------------

/** `repr(float)` — shortest round-trip digits, Python's exponent rules. */
export function floatRepr(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  // toExponential() without arguments yields the shortest unique digits.
  const [mantissa, expPart] = v.toExponential().split('e') as [string, string];
  const exp = Number(expPart);
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const sign = negative ? '-' : '';
  if (exp >= 16 || exp < -4) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp).toString().padStart(2, '0');
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${e}`;
  }
  if (exp >= 0) {
    const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    const frac = digits.slice(exp + 1);
    return `${sign}${intPart}.${frac || '0'}`;
  }
  return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
}

function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === quote) out += `\\${quote}`;
    else out += ch;
  }
  return quote + out + quote;
}

/** `repr(value)` for the modelled subset. Library objects use a compact, readable form. */
export function pyRepr(value: PyValue): string {
  switch (value.t) {
    case 'none':
      return 'None';
    case 'bool':
      return value.v ? 'True' : 'False';
    case 'int':
      return String(value.v);
    case 'float':
      return floatRepr(value.v);
    case 'str':
      return strRepr(value.v);
    case 'unknown':
      return '?';
    case 'set':
      return value.items.length === 0 ? 'set()' : `{${value.items.map(pyRepr).join(', ')}}`;
    case 'exc-type':
      return `<class '${value.name}'>`;
    case 'exception':
      return `${value.name}(${value.message ? strRepr(value.message) : ''})`;
    case 'ellipsis':
      return 'Ellipsis';
    case 'list':
      return `[${value.items.map(pyRepr).join(', ')}]`;
    case 'tuple':
      return value.items.length === 1 ? `(${pyRepr(value.items[0]!)},)` : `(${value.items.map(pyRepr).join(', ')})`;
    case 'dict':
      return `{${value.entries.map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
    case 'range':
      return value.step === 1 ? `range(${value.start}, ${value.stop})` : `range(${value.start}, ${value.stop}, ${value.step})`;
    case 'function':
      return `<function ${value.fn.qualname}>`;
    case 'builtin':
      return `<built-in function ${value.name}>`;
    case 'class':
      return `<class '${value.name}'>`;
    case 'module':
      return `<module '${value.name}'>`;
    case 'np-scalar':
      return npScalarStr(value);
    case 'ndarray':
      return `array([${value.items.map(elementStr).join(', ')}])`;
    case 'series':
      return `Series([${value.items.map(elementStr).join(', ')}], dtype=${value.dtype})`;
    case 'iloc':
      return '<.iloc indexer>';
    case 'method':
      return `<method ${value.owner}.${value.name}>`;
    case 'instance':
      return `${value.cls}(${value.fields.map(([k, f]) => `${k}=${f.t === 'instance' ? `<${f.cls}>` : f.t === 'dataframe' ? `<table ${dataframeRows(f)}×${f.columns.length}>` : shortRepr(f)}`).join(', ')})`;
    case 'bound':
      return `<bound method ${value.cls}.${value.fn.def.name}>`;
    case 'dataframe':
      return `<table ${dataframeRows(value)} rows × ${value.columns.length} columns: ${value.columns.map((c) => c.name).join(', ')}>`;
  }
}

function shortRepr(v: PyValue): string {
  const text = pyRepr(v);
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

export function dataframeRows(df: Extract<PyValue, { t: 'dataframe' }>): number {
  return df.columns[0]?.items.length ?? 0;
}

/** First rows of a table as display strings (header + rows), for small previews. */
export function tablePreview(df: Extract<PyValue, { t: 'dataframe' }>, maxRows = 4): { header: string[]; rows: string[][]; more: number } {
  const n = dataframeRows(df);
  const rows: string[][] = [];
  const cell = (v: PyValue) => (v.t === 'str' ? v.v : numericOf(v) !== null && Number.isNaN(numericOf(v)!) ? 'NaN' : elementStr(v));
  for (let r = 0; r < Math.min(n, maxRows); r++) rows.push(df.columns.map((c) => cell(c.items[r]!)));
  return { header: df.columns.map((c) => c.name), rows, more: Math.max(0, n - maxRows) };
}

function npScalarStr(value: Extract<PyValue, { t: 'np-scalar' }>): string {
  if (value.dtype === 'bool') return value.v ? 'True' : 'False';
  return value.dtype === 'float64' ? floatRepr(value.v) : String(value.v);
}

function elementStr(value: PyValue): string {
  return value.t === 'np-scalar' ? npScalarStr(value) : pyRepr(value);
}

/**
 * `str(value)` as `print` would show it. NumPy/pandas printing is approximated
 * (alignment and truncation rules are simplified); callers flag that.
 */
export function pyStrOf(value: PyValue): string {
  switch (value.t) {
    case 'str':
      return value.v;
    case 'exception':
      return value.message;
    case 'np-scalar':
      return npScalarStr(value);
    case 'ndarray':
      return `[${value.items.map(elementStr).join(' ')}]`;
    case 'series': {
      const width = Math.max(...value.items.map((v) => elementStr(v).length), 1);
      const lines = value.items.map((v, i) => `${String(value.index?.[i] ?? i).padEnd(4)}${elementStr(v).padStart(width)}`);
      return [...lines, `${value.name !== undefined ? `Name: ${value.name}, ` : ''}dtype: ${value.dtype}`].join('\n');
    }
    case 'dataframe': {
      const n = dataframeRows(value);
      // pandas shows text without quotes and missing values as NaN.
      const cell = (v: PyValue) => (v.t === 'str' ? v.v : numericOf(v) !== null && Number.isNaN(numericOf(v)!) ? 'NaN' : elementStr(v));
      const cells = value.columns.map((c) => [c.name, ...c.items.map(cell)]);
      const widths = cells.map((col) => Math.max(...col.map((x) => x.length)));
      const idxWidth = String(Math.max(0, n - 1)).length;
      const line = (r: number) => `${(r === 0 ? '' : String(value.index?.[r - 1] ?? r - 1)).padEnd(idxWidth)} ${cells.map((col, i) => col[r]!.padStart(widths[i]!)).join('  ')}`;
      return Array.from({ length: n + 1 }, (_, r) => line(r)).join('\n');
    }
    default:
      return pyRepr(value);
  }
}

/** True for values whose printed form is an approximation of the library's real output. */
export function isApproximatePrint(value: PyValue): boolean {
  return value.t === 'ndarray' || value.t === 'series' || value.t === 'dataframe';
}

/** Compact display for UI chips (collections are shown separately element by element). */
export function displayValue(value: PyValue, max = 48): string {
  if (value.t === 'dataframe') return `table ${dataframeRows(value)}×${value.columns.length}`;
  if (value.t === 'instance') return `${value.cls} object`;
  const text = value.t === 'str' ? pyRepr(value) : value.t === 'np-scalar' ? npScalarStr(value) : pyRepr(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Elements of a collection for element-wise display. */
export function elementsOf(value: PyValue): readonly PyValue[] | null {
  return isCollection(value) ? value.items : null;
}

export function elementDisplay(value: PyValue): string {
  return elementStr(value);
}
