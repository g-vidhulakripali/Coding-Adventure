import { PyError, UnsupportedError } from './errors';
import { iterate, pyEquals } from './operators';
import { NONE, numericOf, pyRepr, pyStrOf, typeName, type PyValue } from './values';
import { formatValue } from './format';

/**
 * Methods and slicing of Python's own containers and text.
 * Methods that change a container return the new contents in `mutated`; the
 * interpreter stores it so every name holding the container sees the change.
 */

type List = Extract<PyValue, { t: 'list' }>;
type Dict = Extract<PyValue, { t: 'dict' }>;
type SetV = Extract<PyValue, { t: 'set' }>;
type Str = Extract<PyValue, { t: 'str' }>;

export interface MethodResult {
  readonly result: PyValue;
  readonly mutated?: PyValue;
}

const CAP = 20000;
const LIST = ['append', 'extend', 'insert', 'pop', 'remove', 'clear', 'index', 'count', 'copy', 'reverse', 'sort'];
const DICT = ['get', 'keys', 'values', 'items', 'update', 'pop', 'setdefault', 'copy', 'clear'];
const SET = ['add', 'discard', 'remove', 'union', 'intersection', 'difference', 'issubset', 'issuperset', 'update', 'copy'];
const STR = ['upper', 'lower', 'strip', 'lstrip', 'rstrip', 'split', 'join', 'replace', 'startswith', 'endswith', 'find', 'count', 'title', 'capitalize', 'zfill', 'ljust', 'rjust', 'center', 'isdigit', 'isalpha', 'splitlines', 'format', 'removeprefix', 'removesuffix', 'rsplit', 'partition'];

export function hasContainerMethod(v: PyValue, name: string): boolean {
  switch (v.t) {
    case 'list':
      return LIST.includes(name);
    case 'tuple':
      return name === 'index' || name === 'count';
    case 'dict':
      return DICT.includes(name);
    case 'set':
      return SET.includes(name);
    case 'str':
      return STR.includes(name);
    default:
      return false;
  }
}

export function dictGet(d: Dict, key: PyValue): PyValue | undefined {
  return d.entries.find(([k]) => pyEquals(k, key))?.[1];
}

export function dictSet(d: Dict, key: PyValue, value: PyValue): Dict {
  const i = d.entries.findIndex(([k]) => pyEquals(k, key));
  const entries = [...d.entries];
  if (i >= 0) entries[i] = [entries[i]![0], value];
  else entries.push([key, value]);
  return { ...d, entries };
}

export function uniqueItems(items: readonly PyValue[]): PyValue[] {
  const out: PyValue[] = [];
  for (const v of items) if (!out.some((o) => pyEquals(o, v))) out.push(v);
  return out;
}

const str = (v: string): PyValue => ({ t: 'str', v });
const int = (v: number): PyValue => ({ t: 'int', v });
const bool = (v: boolean): PyValue => ({ t: 'bool', v });

function position(v: PyValue | undefined, size: number, what: string): number {
  const n = v ? numericOf(v) : size - 1;
  if (n === null) throw new PyError('TypeError', `'${typeName(v!)}' object cannot be interpreted as an integer`);
  const i = n < 0 ? n + size : n;
  if (i < 0 || i >= size) throw new PyError('IndexError', `${what} index out of range`);
  return i;
}

export function callContainerMethod(self: PyValue, name: string, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>): MethodResult {
  if (kwargs.size > 0 && self.t !== 'str') throw new UnsupportedError(`Keyword arguments of .${name}() are not modelled.`);
  switch (self.t) {
    case 'list':
    case 'tuple':
      return listMethod(self as List, name, args);
    case 'dict':
      return dictMethod(self, name, args);
    case 'set':
      return setMethod(self, name, args);
    case 'str':
      return { result: strMethod(self, name, args, kwargs) };
    default:
      throw new UnsupportedError(`.${name}() of ${typeName(self)} is not modelled.`);
  }
}

function listMethod(self: List, name: string, args: readonly PyValue[]): MethodResult {
  const items = [...self.items];
  const changed = (next: PyValue[], result: PyValue = NONE): MethodResult => ({ result, mutated: { ...self, items: next } });
  switch (name) {
    case 'append':
      return changed([...items, args[0]!]);
    case 'extend':
      return changed([...items, ...iterate(args[0]!, CAP)]);
    case 'insert': {
      const n = numericOf(args[0]!) ?? 0;
      items.splice(n < 0 ? Math.max(0, n + items.length) : n, 0, args[1]!);
      return changed(items);
    }
    case 'pop': {
      if (items.length === 0) throw new PyError('IndexError', 'pop from empty list');
      const [v] = items.splice(position(args[0], items.length, 'pop'), 1);
      return changed(items, v!);
    }
    case 'remove': {
      const i = items.findIndex((v) => pyEquals(v, args[0]!));
      if (i < 0) throw new PyError('ValueError', 'list.remove(x): x not in list');
      items.splice(i, 1);
      return changed(items);
    }
    case 'clear':
      return changed([]);
    case 'reverse':
      return changed(items.reverse());
    case 'copy':
      return { result: { t: 'list', items } };
    case 'count':
      return { result: int(items.filter((v) => pyEquals(v, args[0]!)).length) };
    case 'index': {
      const i = items.findIndex((v) => pyEquals(v, args[0]!));
      if (i < 0) throw new PyError('ValueError', `${pyRepr(args[0]!)} is not in list`);
      return { result: int(i) };
    }
    default:
      throw new UnsupportedError(`list.${name}() is not modelled.`);
  }
}

function dictMethod(self: Dict, name: string, args: readonly PyValue[]): MethodResult {
  const pairs = (): PyValue[] => self.entries.map(([k, v]) => ({ t: 'tuple', items: [k, v] }));
  switch (name) {
    case 'get':
      return { result: dictGet(self, args[0]!) ?? args[1] ?? NONE };
    case 'keys':
      return { result: { t: 'list', items: self.entries.map(([k]) => k) } };
    case 'values':
      return { result: { t: 'list', items: self.entries.map(([, v]) => v) } };
    case 'items':
      return { result: { t: 'list', items: pairs() } };
    case 'copy':
      return { result: { t: 'dict', entries: self.entries } };
    case 'clear':
      return { result: NONE, mutated: { ...self, entries: [] } };
    case 'update': {
      const other = args[0];
      if (!other || other.t !== 'dict') throw new UnsupportedError('dict.update() is only modelled with a dictionary.');
      return { result: NONE, mutated: other.entries.reduce((d, [k, v]) => dictSet(d, k, v), self) };
    }
    case 'pop': {
      const found = dictGet(self, args[0]!);
      if (found === undefined) {
        if (args[1]) return { result: args[1] };
        throw new PyError('KeyError', pyRepr(args[0]!));
      }
      return { result: found, mutated: { ...self, entries: self.entries.filter(([k]) => !pyEquals(k, args[0]!)) } };
    }
    case 'setdefault': {
      const found = dictGet(self, args[0]!);
      return found !== undefined ? { result: found } : { result: args[1] ?? NONE, mutated: dictSet(self, args[0]!, args[1] ?? NONE) };
    }
    default:
      throw new UnsupportedError(`dict.${name}() is not modelled.`);
  }
}

function setMethod(self: SetV, name: string, args: readonly PyValue[]): MethodResult {
  const other = () => args.flatMap((a) => iterate(a, CAP));
  const has = (list: readonly PyValue[], v: PyValue) => list.some((o) => pyEquals(o, v));
  switch (name) {
    case 'add':
      return { result: NONE, mutated: { ...self, items: uniqueItems([...self.items, args[0]!]) } };
    case 'update':
      return { result: NONE, mutated: { ...self, items: uniqueItems([...self.items, ...other()]) } };
    case 'remove':
    case 'discard':
      if (name === 'remove' && !has(self.items, args[0]!)) throw new PyError('KeyError', pyRepr(args[0]!));
      return { result: NONE, mutated: { ...self, items: self.items.filter((v) => !pyEquals(v, args[0]!)) } };
    case 'union':
      return { result: { t: 'set', items: uniqueItems([...self.items, ...other()]) } };
    case 'intersection':
      return { result: { t: 'set', items: self.items.filter((v) => has(other(), v)) } };
    case 'difference':
      return { result: { t: 'set', items: self.items.filter((v) => !has(other(), v)) } };
    case 'issubset':
      return { result: bool(self.items.every((v) => has(other(), v))) };
    case 'issuperset':
      return { result: bool(other().every((v) => has(self.items, v))) };
    case 'copy':
      return { result: { t: 'set', items: self.items } };
    default:
      throw new UnsupportedError(`set.${name}() is not modelled.`);
  }
}

function strMethod(self: Str, name: string, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>): PyValue {
  const s = self.v;
  const text = (i: number): string => {
    const a = args[i];
    if (!a || a.t !== 'str') throw new PyError('TypeError', `${name}() argument ${i + 1} must be str, not ${a ? typeName(a) : 'nothing'}`);
    return a.v;
  };
  const num = (i: number) => (args[i] ? numericOf(args[i]!) ?? 0 : 0);
  if (kwargs.size > 0 && name !== 'format') throw new UnsupportedError(`Keyword arguments of str.${name}() are not modelled.`);
  const chars = args[0] && args[0].t === 'str' ? args[0].v : null;
  const inSet = (c: string) => (chars === null ? /\s/.test(c) : chars.includes(c));
  const left = (x: string) => {
    let i = 0;
    while (i < x.length && inSet(x[i]!)) i++;
    return x.slice(i);
  };
  const right = (x: string) => {
    let i = x.length;
    while (i > 0 && inSet(x[i - 1]!)) i--;
    return x.slice(0, i);
  };
  switch (name) {
    case 'upper':
      return str(s.toUpperCase());
    case 'lower':
      return str(s.toLowerCase());
    case 'capitalize':
      return str(s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
    case 'title':
      return str(s.toLowerCase().replace(/[a-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1)));
    case 'strip':
      return str(left(right(s)));
    case 'lstrip':
      return str(left(s));
    case 'rstrip':
      return str(right(s));
    case 'replace':
      if (args[2]) throw new UnsupportedError('str.replace() with a count is not modelled.');
      return str(s.split(text(0)).join(text(1)));
    case 'startswith':
    case 'endswith': {
      const options = args[0]!.t === 'tuple' ? args[0]!.items : [args[0]!];
      return bool(options.some((o) => o.t === 'str' && (name === 'startswith' ? s.startsWith(o.v) : s.endsWith(o.v))));
    }
    case 'find':
      return int(s.indexOf(text(0)));
    case 'count':
      return int(s.split(text(0)).length - 1);
    case 'split': {
      if (!args[0] || args[0].t === 'none') {
        const words = s.trim().split(/\s+/).filter(Boolean);
        if (args[1]) throw new UnsupportedError('str.split() with a limit on blanks is not modelled.');
        return { t: 'list', items: words.map(str) };
      }
      const parts = s.split(text(0));
      const limit = args[1] ? num(1) : -1;
      const out = limit >= 0 && parts.length > limit + 1 ? [...parts.slice(0, limit), parts.slice(limit).join(text(0))] : parts;
      return { t: 'list', items: out.map(str) };
    }
    case 'rsplit': {
      const parts = s.split(text(0));
      const limit = args[1] ? num(1) : -1;
      const cut = parts.length - limit;
      const out = limit >= 0 && parts.length > limit + 1 ? [parts.slice(0, cut).join(text(0)), ...parts.slice(cut)] : parts;
      return { t: 'list', items: out.map(str) };
    }
    case 'partition': {
      const i = s.indexOf(text(0));
      return { t: 'tuple', items: (i < 0 ? [s, '', ''] : [s.slice(0, i), text(0), s.slice(i + text(0).length)]).map(str) };
    }
    case 'splitlines':
      return { t: 'list', items: s.replace(/\n$/, '').split('\n').map(str) };
    case 'join':
      return str(
        iterate(args[0]!, CAP)
          .map((v, i) => {
            if (v.t !== 'str') throw new PyError('TypeError', `sequence item ${i}: expected str instance, ${typeName(v)} found`);
            return v.v;
          })
          .join(s),
      );
    case 'zfill':
      return str(s.padStart(num(0), '0'));
    case 'ljust':
      return str(s.padEnd(num(0)));
    case 'rjust':
      return str(s.padStart(num(0)));
    case 'isdigit':
      return bool(/^\d+$/.test(s));
    case 'isalpha':
      return bool(/^[A-Za-z]+$/.test(s));
    case 'removeprefix':
      return str(s.startsWith(text(0)) ? s.slice(text(0).length) : s);
    case 'removesuffix':
      return str(text(0) && s.endsWith(text(0)) ? s.slice(0, s.length - text(0).length) : s);
    case 'format': {
      let auto = 0;
      return str(
        s.replace(/\{\{|\}\}|\{([^{}:]*)(?::([^{}]*))?\}/g, (whole: string, field: string | undefined, spec: string | undefined) => {
          if (whole === '{{') return '{';
          if (whole === '}}') return '}';
          const v = field === undefined || field === '' ? args[auto++] : /^\d+$/.test(field) ? args[Number(field)] : kwargs.get(field);
          if (!v) throw new UnsupportedError('This str.format() field is not modelled.');
          return spec ? formatValue(v, spec) : pyStrOf(v);
        }),
      );
    }
    default:
      throw new UnsupportedError(`str.${name}() is not modelled.`);
  }
}

// ---- Slicing --------------------------------------------------------------------

export interface SliceBounds {
  readonly lower: PyValue | null;
  readonly upper: PyValue | null;
  readonly step: PyValue | null;
}

/** The positions `a[lower:upper:step]` selects, with Python's clamping rules. */
export function slicePositions(b: SliceBounds, size: number): number[] {
  const value = (v: PyValue | null): number | null => {
    if (!v || v.t === 'none') return null;
    const n = numericOf(v);
    if (n === null) throw new PyError('TypeError', 'slice indices must be integers or None or have an __index__ method');
    return n;
  };
  const step = value(b.step) ?? 1;
  if (step === 0) throw new PyError('ValueError', 'slice step cannot be zero');
  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n < 0 ? n + size : n, lo), hi);
  const lo = value(b.lower);
  const hi = value(b.upper);
  const out: number[] = [];
  if (step > 0) for (let i = lo === null ? 0 : clamp(lo, 0, size), end = hi === null ? size : clamp(hi, 0, size); i < end; i += step) out.push(i);
  else for (let i = lo === null ? size - 1 : clamp(lo, -1, size - 1), end = hi === null ? -1 : clamp(hi, -1, size - 1); i > end; i += step) out.push(i);
  return out;
}

export function sliceValue(v: PyValue, b: SliceBounds): PyValue {
  switch (v.t) {
    case 'str': {
      const chars = [...v.v];
      return str(slicePositions(b, chars.length).map((i) => chars[i]).join(''));
    }
    case 'list':
    case 'tuple':
      return { t: v.t, items: slicePositions(b, v.items.length).map((i) => v.items[i]!) };
    case 'ndarray':
      return { ...v, items: slicePositions(b, v.items.length).map((i) => v.items[i]!) };
    case 'series':
    case 'iloc': {
      const s = v.t === 'iloc' ? v.series : v;
      const at = slicePositions(b, s.items.length);
      return { ...s, items: at.map((i) => s.items[i]!), index: at.map((i) => s.index?.[i] ?? i) };
    }
    default:
      throw new UnsupportedError(`Slicing ${typeName(v)} is not modelled.`);
  }
}
