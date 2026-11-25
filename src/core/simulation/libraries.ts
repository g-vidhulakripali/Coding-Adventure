import { PyError, UnsupportedError } from './errors';
import { numericOf, pyFloat, pyInt, typeName, type DType, type PyValue } from './values';

/**
 * JavaScript models of a few NumPy / pandas operations.
 *
 * Each function documents the library behaviour it models. Only 1-D arrays and
 * Series with the default RangeIndex are modelled. Anything else raises
 * UnsupportedError so the simulation stops instead of guessing.
 */

export const MODELLED_LIBRARIES: Record<string, string> = {
  pandas: 'pandas',
  numpy: 'NumPy',
};

type Series = Extract<PyValue, { t: 'series' }>;
type DataFrame = Extract<PyValue, { t: 'dataframe' }>;
type NdArray = Extract<PyValue, { t: 'ndarray' }>;

/** Attribute on a modelled library module, e.g. `pd.Series`. */
export function moduleAttribute(moduleName: string, attr: string): PyValue {
  const root = moduleName.split('.')[0];
  if (root === 'pandas' && attr === 'Series') return { t: 'builtin', name: 'pandas.Series' };
  // Reading a CSV is handled by the interpreter, which has access to the project's data files.
  if (root === 'pandas' && attr === 'read_csv') return { t: 'builtin', name: 'pandas.read_csv' };
  if (root === 'numpy' && attr === 'array') return { t: 'builtin', name: 'numpy.array' };
  if (root === 'numpy' && (attr === 'float64' || attr === 'int64')) return { t: 'builtin', name: `numpy.${attr}` };
  throw new UnsupportedError(`\`${moduleName}.${attr}\` is not modelled by the simulation yet.`);
}

/** Converts a value to a NumPy element of `dtype` (np.float64 / np.int64 / bool / Python object). */
function toElement(value: PyValue, dtype: DType): PyValue {
  if (dtype === 'object') return value;
  const n = numericOf(value);
  if (n === null) {
    if (value.t === 'str' && dtype === 'float64') {
      const parsed = Number(value.v.trim());
      if (value.v.trim() === '' || Number.isNaN(parsed)) throw new PyError('ValueError', `could not convert string to float: '${value.v}'`);
      return { t: 'np-scalar', dtype: 'float64', v: parsed };
    }
    throw new PyError('TypeError', `cannot convert ${typeName(value)} to ${dtype}`);
  }
  if (dtype === 'int64') return { t: 'np-scalar', dtype: 'int64', v: Math.trunc(n) };
  if (dtype === 'bool') return { t: 'np-scalar', dtype: 'bool', v: n !== 0 ? 1 : 0 };
  return { t: 'np-scalar', dtype: 'float64', v: n };
}

/** NumPy/pandas dtype inference for a flat list of Python values. */
function inferDType(items: readonly PyValue[]): DType {
  if (items.length === 0) return 'float64'; // pandas ≥2 default for empty numeric Series is object; numpy is float64
  if (items.every((v) => v.t === 'bool' || (v.t === 'np-scalar' && v.dtype === 'bool'))) return 'bool';
  if (items.every((v) => v.t === 'int' || (v.t === 'np-scalar' && v.dtype === 'int64'))) return 'int64';
  if (items.every((v) => v.t === 'int' || v.t === 'float' || (v.t === 'np-scalar' && v.dtype !== 'bool'))) return 'float64';
  return 'object';
}

function dtypeFromArg(value: PyValue | undefined): DType | null {
  if (!value || value.t === 'none') return null;
  if (value.t === 'builtin') {
    if (value.name === 'float' || value.name === 'numpy.float64') return 'float64';
    if (value.name === 'int' || value.name === 'numpy.int64') return 'int64';
    if (value.name === 'bool') return 'bool';
  }
  if (value.t === 'str' && ['float', 'float64', 'int', 'int64', 'bool', 'object'].includes(value.v)) {
    return value.v.startsWith('float') ? 'float64' : value.v.startsWith('int') ? 'int64' : (value.v as DType);
  }
  throw new UnsupportedError(`dtype ${typeName(value)} is not modelled.`);
}

function flatItems(value: PyValue, what: string): readonly PyValue[] {
  if (value.t === 'list' || value.t === 'tuple' || value.t === 'ndarray' || value.t === 'series') {
    if (value.items.some((v) => v.t === 'list' || v.t === 'tuple')) throw new UnsupportedError(`Only 1-D data is modelled for ${what}.`);
    return value.items;
  }
  throw new UnsupportedError(`${what} from ${typeName(value)} is not modelled.`);
}

/** `pd.Series(data, dtype=None)` and `np.array(obj, dtype=None)`. */
export function callLibraryFunction(name: string, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>): PyValue {
  for (const key of kwargs.keys()) {
    if (key !== 'dtype') throw new UnsupportedError(`Keyword \`${key}=\` of ${name}() is not modelled.`);
  }
  if (name === 'numpy.float64' || name === 'numpy.int64') {
    if (args.length !== 1) throw new UnsupportedError(`${name}() with ${args.length} arguments is not modelled.`);
    return toElement(args[0]!, name === 'numpy.float64' ? 'float64' : 'int64');
  }
  if (args.length !== 1) throw new UnsupportedError(`${name}() with ${args.length} positional arguments is not modelled.`);
  const items = flatItems(args[0]!, `${name}()`);
  const dtype = dtypeFromArg(kwargs.get('dtype')) ?? inferDType(items);
  const converted = items.map((v) => toElement(v, dtype));
  if (name === 'pandas.Series') return { t: 'series', dtype, items: converted };
  if (name === 'numpy.array') return { t: 'ndarray', dtype, items: converted };
  throw new UnsupportedError(`${name}() is not modelled.`);
}

function column(df: DataFrame, name: string): Series {
  const col = df.columns.find((c) => c.name === name);
  if (!col) throw new PyError('KeyError', `'${name}'`);
  return { t: 'series', dtype: col.dtype, items: col.items, name };
}

function sliceRows(df: DataFrame, from: number, to: number): DataFrame {
  return { t: 'dataframe', columns: df.columns.map((c) => ({ ...c, items: c.items.slice(from, to) })) };
}

/** Attribute access on a Series / ndarray / DataFrame. */
export function objectAttribute(value: PyValue, attr: string): PyValue {
  if (value.t === 'dataframe') {
    const rows = value.columns[0]?.items.length ?? 0;
    if (attr === 'shape') return { t: 'tuple', items: [pyInt(rows), pyInt(value.columns.length)] };
    if (attr === 'columns') return { t: 'list', items: value.columns.map((c) => ({ t: 'str', v: c.name })) };
    if (attr === 'empty') return { t: 'bool', v: rows === 0 };
    if (['head', 'tail'].includes(attr)) return { t: 'method', self: value, name: attr, owner: 'DataFrame' };
    // pandas also exposes columns as attributes: df.hours
    if (value.columns.some((c) => c.name === attr)) return column(value, attr);
  }
  if (value.t === 'series') {
    if (attr === 'iloc') return { t: 'iloc', series: value };
    if (attr === 'values') return { t: 'ndarray', dtype: value.dtype, items: value.items };
    if (attr === 'size') return pyInt(value.items.length);
    if (['to_numpy', 'sum', 'mean', 'max', 'min', 'tolist'].includes(attr)) return { t: 'method', self: value, name: attr, owner: 'Series' };
  }
  if (value.t === 'ndarray') {
    if (attr === 'size') return pyInt(value.items.length);
    if (['sum', 'mean', 'max', 'min', 'tolist'].includes(attr)) return { t: 'method', self: value, name: attr, owner: 'ndarray' };
  }
  throw new UnsupportedError(`Attribute \`.${attr}\` of ${typeName(value)} is not modelled yet.`);
}

function reduce(container: Series | NdArray, name: string): PyValue {
  const all = container.items.map((v) => {
    const n = numericOf(v);
    if (n === null) throw new UnsupportedError(`.${name}() over non-numeric data is not modelled.`);
    return n;
  });
  // pandas skips missing values (NaN) by default; NumPy does not.
  const nums = container.t === 'series' ? all.filter((n) => !Number.isNaN(n)) : all;
  const isInt = container.dtype === 'int64' || container.dtype === 'bool';
  if (name === 'sum') {
    const total = nums.reduce((a, b) => a + b, 0);
    return { t: 'np-scalar', dtype: isInt ? 'int64' : 'float64', v: total };
  }
  if (nums.length === 0) {
    if (name === 'mean') return { t: 'np-scalar', dtype: 'float64', v: NaN };
    throw new PyError('ValueError', `zero-size array to reduction operation ${name === 'max' ? 'maximum' : 'minimum'} which has no identity`);
  }
  if (name === 'mean') return { t: 'np-scalar', dtype: 'float64', v: nums.reduce((a, b) => a + b, 0) / nums.length };
  const v = name === 'max' ? Math.max(...nums) : Math.min(...nums);
  return { t: 'np-scalar', dtype: isInt ? 'int64' : 'float64', v };
}

/** Calls a modelled method: `series.to_numpy(dtype=float)`, `.sum()`, `.tolist()` … */
export function callMethod(method: Extract<PyValue, { t: 'method' }>, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>): PyValue {
  const self = method.self;
  if (self.t === 'dataframe' && (method.name === 'head' || method.name === 'tail')) {
    if (kwargs.size > 0 && !kwargs.has('n')) throw new UnsupportedError(`Keywords of .${method.name}() other than n= are not modelled.`);
    const nValue = args[0] ?? kwargs.get('n');
    const n = nValue ? numericOf(nValue) : 5;
    if (n === null) throw new PyError('TypeError', `n must be an integer`);
    const rows = self.columns[0]?.items.length ?? 0;
    return method.name === 'head' ? sliceRows(self, 0, n >= 0 ? n : Math.max(0, rows + n)) : sliceRows(self, n >= 0 ? Math.max(0, rows - n) : -n, rows);
  }
  if (self.t !== 'series' && self.t !== 'ndarray') throw new UnsupportedError(`Method .${method.name}() is not modelled.`);
  if (method.name === 'to_numpy' && self.t === 'series') {
    for (const key of kwargs.keys()) if (key !== 'dtype') throw new UnsupportedError(`Keyword \`${key}=\` of .to_numpy() is not modelled.`);
    if (args.length > 0) throw new UnsupportedError('Positional arguments to .to_numpy() are not modelled.');
    const dtype = dtypeFromArg(kwargs.get('dtype')) ?? self.dtype;
    return { t: 'ndarray', dtype, items: self.items.map((v) => toElement(v, dtype)) };
  }
  if (args.length > 0 || kwargs.size > 0) throw new UnsupportedError(`Arguments to .${method.name}() are not modelled.`);
  if (method.name === 'tolist') {
    return {
      t: 'list',
      items: self.items.map((v) => (v.t === 'np-scalar' ? (v.dtype === 'float64' ? pyFloat(v.v) : v.dtype === 'bool' ? { t: 'bool', v: v.v !== 0 } : pyInt(v.v)) : v)),
    };
  }
  return reduce(self, method.name);
}

/** NumPy integer indexing rules for a 1-D array. */
function arrayPosition(index: PyValue, size: number): number {
  const isInteger = index.t === 'int' || index.t === 'bool' || (index.t === 'np-scalar' && index.dtype === 'int64');
  if (!isInteger) {
    throw new PyError(
      'IndexError',
      'only integers, slices (`:`), ellipsis (`...`), numpy.newaxis (`None`) and integer or boolean arrays are valid indices',
    );
  }
  const raw = numericOf(index)!;
  const pos = raw < 0 ? raw + size : raw;
  if (pos < 0 || pos >= size) throw new PyError('IndexError', `index ${raw} is out of bounds for axis 0 with size ${size}`);
  return pos;
}

export interface Selection {
  readonly value: PyValue;
  /** Position of the selected element, for highlighting. */
  readonly position: number | null;
}

/** `container[index]` for the modelled container types. */
export function subscript(container: PyValue, index: PyValue): Selection {
  switch (container.t) {
    case 'list':
    case 'tuple':
    case 'str': {
      const items = container.t === 'str' ? [...container.v] : container.items;
      const isInteger = index.t === 'int' || index.t === 'bool' || (index.t === 'np-scalar' && index.dtype === 'int64');
      if (!isInteger) throw new PyError('TypeError', `${container.t} indices must be integers or slices, not ${typeName(index)}`);
      const raw = numericOf(index)!;
      const pos = raw < 0 ? raw + items.length : raw;
      if (pos < 0 || pos >= items.length) throw new PyError('IndexError', `${container.t} index out of range`);
      const item = items[pos]!;
      return { value: typeof item === 'string' ? { t: 'str', v: item } : item, position: pos };
    }
    case 'dict': {
      const entry = container.entries.find(([k]) => k.t === index.t && JSON.stringify(k) === JSON.stringify(index));
      if (!entry) throw new PyError('KeyError', index.t === 'str' ? `'${index.v}'` : JSON.stringify(numericOf(index)));
      return { value: entry[1], position: container.entries.indexOf(entry) };
    }
    case 'ndarray': {
      const pos = arrayPosition(index, container.items.length);
      return { value: container.items[pos]!, position: pos };
    }
    case 'iloc': {
      const items = container.series.items;
      const isInteger = index.t === 'int' || (index.t === 'np-scalar' && index.dtype === 'int64');
      if (!isInteger) throw new UnsupportedError(`.iloc with a ${typeName(index)} index is not modelled.`);
      const raw = numericOf(index)!;
      const pos = raw < 0 ? raw + items.length : raw;
      if (pos < 0 || pos >= items.length) throw new PyError('IndexError', 'single positional indexer is out-of-bounds');
      return { value: items[pos]!, position: pos };
    }
    case 'series': {
      // Default RangeIndex: label lookup equals position for non-negative ints.
      const n = numericOf(index);
      const isInteger = index.t === 'int' || (index.t === 'np-scalar' && index.dtype === 'int64');
      if (!isInteger || n === null) throw new UnsupportedError(`Series lookup with a ${typeName(index)} label is not modelled.`);
      if (n < 0 || n >= container.items.length) throw new PyError('KeyError', String(n));
      return { value: container.items[n]!, position: n };
    }
    case 'dataframe': {
      // df["col"] → the column; df[["a", "b"]] → a smaller table.
      if (index.t === 'str') return { value: column(container, index.v), position: container.columns.findIndex((c) => c.name === index.v) };
      if (index.t === 'list' && index.items.every((i) => i.t === 'str')) {
        const picked = index.items.map((i) => column(container, (i as { v: string }).v));
        return { value: { t: 'dataframe', columns: picked.map((c) => ({ name: c.name!, dtype: c.dtype, items: c.items })) }, position: null };
      }
      throw new UnsupportedError(`Table lookup with a ${typeName(index)} is not modelled (use a column name).`);
    }
    default:
      throw new PyError('TypeError', `'${typeName(container)}' object is not subscriptable`);
  }
}
