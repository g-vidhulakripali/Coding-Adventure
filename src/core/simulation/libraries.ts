import { PyError, UnsupportedError } from './errors';
import { dictGet, sliceValue, slicePositions, type SliceBounds } from './containers';
import { callNumeric, callNumericMethod, columnOf, hasNumericMethod, libraryAttribute, maskPositions, rowsOf, takeRows, type DataFrame } from './numeric';
import { NONE, numericOf, pyInt, pyRepr, typeName, type PyValue } from './values';

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
  math: 'math',
  os: 'os.path',
};


/** Attribute on a modelled library module, e.g. `pd.Series`. */
export function moduleAttribute(moduleName: string, attr: string): PyValue {
  const value = libraryAttribute(moduleName, attr);
  if (!value) throw new UnsupportedError(`\`${moduleName}.${attr}\` is not computed here.`);
  return value;
}

/** Calls a modelled library function, e.g. `pandas.Series`, `numpy.sqrt`, `math.floor`. */
export function callLibraryFunction(name: string, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>): PyValue {
  return callNumeric(name, args, kwargs);
}

/** Attribute access on a Series / ndarray / DataFrame. */
export function objectAttribute(value: PyValue, attr: string): PyValue {
  const owner = value.t === 'series' ? 'Series' : value.t === 'ndarray' ? 'ndarray' : 'DataFrame';
  if (value.t === 'dataframe') {
    if (attr === 'shape') return { t: 'tuple', items: [pyInt(rowsOf(value)), pyInt(value.columns.length)] };
    if (attr === 'columns') return { t: 'list', items: value.columns.map((c) => ({ t: 'str', v: c.name })) };
    if (attr === 'empty') return { t: 'bool', v: rowsOf(value) === 0 || value.columns.length === 0 };
    if (attr === 'loc' || attr === 'iloc') return { t: 'method', self: value, name: attr, owner };
  }
  if (value.t === 'series') {
    if (attr === 'iloc') return { t: 'iloc', series: value };
    if (attr === 'loc') return { t: 'method', self: value, name: attr, owner };
    if (attr === 'values') return { t: 'ndarray', dtype: value.dtype, items: value.items };
    if (attr === 'name') return value.name === undefined ? NONE : { t: 'str', v: value.name };
    if (attr === 'empty') return { t: 'bool', v: value.items.length === 0 };
  }
  if (value.t === 'series' || value.t === 'ndarray') {
    if (attr === 'size') return pyInt(value.items.length);
    if (attr === 'shape') return { t: 'tuple', items: [pyInt(value.items.length)] };
    if (attr === 'ndim') return pyInt(1);
  }
  if (hasNumericMethod(value, attr)) return { t: 'method', self: value, name: attr, owner };
  // pandas also exposes columns as attributes: df.hours
  if (value.t === 'dataframe' && value.columns.some((c) => c.name === attr)) return columnOf(value, attr);
  throw new UnsupportedError(`\`.${attr}\` of ${typeName(value)} is not computed here.`);
}

/** Calls a modelled method: `series.to_numpy(dtype=float)`, `.sum()`, `.dropna()` … */
export function callMethod(method: Extract<PyValue, { t: 'method' }>, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>): PyValue {
  return callNumericMethod(method.self, method.name, args, kwargs);
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
      const found = dictGet(container, index);
      if (found === undefined) throw new PyError('KeyError', pyRepr(index));
      return { value: found, position: null };
    }
    case 'ndarray': {
      const keep = maskPositions(index, container.items.length);
      if (keep) return { value: { ...container, items: keep.map((i) => container.items[i]!) }, position: null };
      if (index.t !== 'int' && index.t !== 'bool' && index.t !== 'np-scalar' && index.t !== 'float') throw new UnsupportedError(`Array lookup with a ${typeName(index)} is not modelled.`);
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
      const keep = maskPositions(index, container.items.length);
      if (keep) return { value: takeRows(container, keep), position: null };
      // Lookup by row label (0…n-1 unless rows were filtered or sorted).
      const n = numericOf(index);
      const isInteger = index.t === 'int' || (index.t === 'np-scalar' && index.dtype === 'int64');
      if (!isInteger || n === null) throw new UnsupportedError(`Series lookup with a ${typeName(index)} label is not modelled.`);
      const at = container.index ? container.index.indexOf(n) : n >= 0 && n < container.items.length ? n : -1;
      if (at < 0) throw new PyError('KeyError', String(n));
      return { value: container.items[at]!, position: at };
    }
    case 'dataframe': {
      // df["col"] → the column; df[["a", "b"]] → a smaller table; df[mask] → the rows where it is True.
      if (index.t === 'str') return { value: columnOf(container, index.v), position: container.columns.findIndex((c) => c.name === index.v) };
      const keep = maskPositions(index, rowsOf(container));
      if (keep) return { value: takeRows(withoutRef(container), keep), position: null };
      if (index.t === 'list') return { value: pickColumns(container, index.items), position: null };
      throw new UnsupportedError(`Table lookup with a ${typeName(index)} is not modelled.`);
    }
    case 'method': {
      // df.loc[rows, columns] and series.loc[rows]
      const self = container.self;
      if (container.name === 'loc' && self.t === 'dataframe') {
        const [rows, cols] = index.t === 'tuple' ? index.items : [index, undefined];
        const keep = maskPositions(rows!, rowsOf(self));
        if (!keep) throw new UnsupportedError('`.loc` with row labels is not modelled.');
        const table = takeRows(withoutRef(self), keep);
        if (!cols) return { value: table, position: null };
        return { value: cols.t === 'str' ? columnOf(table, cols.v) : pickColumns(table, cols.t === 'list' ? cols.items : []), position: null };
      }
      if (container.name === 'loc' && self.t === 'series') return subscript(self, index);
      throw new UnsupportedError(`\`.${container.name}[…]\` is not modelled here.`);
    }
    default:
      throw new PyError('TypeError', `'${typeName(container)}' object is not subscriptable`);
  }
}

function withoutRef(df: DataFrame): DataFrame {
  const { ref: _ref, ...rest } = df;
  return rest;
}

function pickColumns(df: DataFrame, names: readonly PyValue[]): DataFrame {
  const cols = names.map((n) => {
    if (n.t !== 'str') throw new UnsupportedError('This column selection is not modelled.');
    return columnOf(df, n.v);
  });
  return { ...withoutRef(df), columns: cols.map((c) => ({ name: c.name!, dtype: c.dtype, items: c.items })) };
}

/** `a[lower:upper:step]` for every container that supports it. */
export function sliceOf(container: PyValue, bounds: SliceBounds): PyValue {
  if (container.t === 'method' && container.name === 'iloc' && container.self.t === 'dataframe') {
    return takeRows(withoutRef(container.self), slicePositions(bounds, rowsOf(container.self)));
  }
  if (container.t === 'series') throw new UnsupportedError('Slicing a Series directly is not modelled (use .iloc).');
  return sliceValue(container, bounds);
}
