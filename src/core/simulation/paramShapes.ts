import type { Expr, FunctionDef, Module, Stmt } from '../parser/python/ast';

/**
 * What a function's code expects of each parameter, read from the syntax tree:
 * a table (pandas) and its columns, a dictionary and its keys, or a plain value.
 * Used only to offer the right input boxes. A guess here never becomes a value.
 */

/** Parsed files by path (a Map, or something that parses on demand). */
export interface ModuleLookup {
  get(path: string): Module | undefined;
  keys(): Iterable<string>;
}

export type ParamShape = 'value' | 'table' | 'dict';

export interface ParamHint {
  readonly shape: ParamShape;
  /** Column or key names the code uses on this parameter. */
  readonly keys: readonly string[];
  /** Texts a column or key is compared with, e.g. `df["phase"] == "idle"`. */
  readonly compared: ReadonlyMap<string, readonly string[]>;
}

/** Only tables have these; a column read from a table (`df["x"].mean()`) counts too. */
const TABLE_ATTRS = new Set(['loc', 'iloc', 'columns', 'groupby', 'merge', 'sort_values', 'set_index', 'reset_index', 'dropna', 'fillna', 'itertuples', 'iterrows', 'pivot_table', 'drop_duplicates', 'shape', 'empty', 'assign', 'rename', 'to_csv', 'head', 'tail', 'query']);
const COLUMN_ATTRS = new Set(['to_numpy', 'mean', 'median', 'std', 'sum', 'max', 'min', 'isin', 'astype', 'dropna', 'fillna', 'notna', 'isna', 'diff', 'cumsum', 'iloc', 'unique', 'nunique', 'values', 'tolist', 'abs', 'shift', 'between', 'map', 'dt', 'str', 'any', 'all', 'quantile', 'rolling', 'value_counts']);
const DICT_ATTRS = new Set(['get', 'items', 'keys', 'values', 'setdefault', 'pop', 'update']);

/** Text a constant such as `K.HEIGHT_COL` stands for, when it is written down plainly in the project. */
export function constantText(e: Expr, module: Module, path: string, modules: ModuleLookup): string | null {
  if (e.type === 'Constant') return e.kind === 'str' ? (e.value as string) : null;
  if (e.type === 'Name') return topLevelText(module, e.id);
  if (e.type !== 'Attribute' || e.value.type !== 'Name') return null;
  const alias = e.value.id;
  for (const s of module.body) {
    if (s.type !== 'Import' && s.type !== 'ImportFrom') continue;
    for (const n of s.names) {
      if ((n.asname ?? n.name) !== alias) continue;
      const dotted = s.type === 'Import' ? n.name : [s.module, n.name].filter(Boolean).join('.');
      const tail = `${dotted.replace(/\./g, '/')}.py`;
      const target = [...modules.keys()].find((p) => p === tail || p.endsWith(`/${tail}`));
      return target && target !== path ? topLevelText(modules.get(target)!, e.attr) : null;
    }
  }
  return null;
}

function topLevelText(module: Module, name: string): string | null {
  for (const s of module.body) {
    if (s.type === 'Assign' && s.targets.length === 1 && s.targets[0]!.type === 'Name' && s.targets[0].id === name) {
      return s.value.type === 'Constant' && s.value.kind === 'str' ? (s.value.value as string) : null;
    }
  }
  return null;
}

export function paramHints(def: FunctionDef, path: string, modules: ModuleLookup): ReadonlyMap<string, ParamHint> {
  const module = modules.get(path);
  const names = new Set(def.params.filter((p) => p.kind !== 'varargs' && p.kind !== 'varkw').map((p) => p.name));
  const info = new Map([...names].map((n) => [n, { table: 0, dict: 0, keys: [] as string[], compared: new Map<string, string[]>() }]));
  const text = (e: Expr) => (module ? constantText(e, module, path, modules) : null);
  const addKey = (name: string, key: string) => {
    const keys = info.get(name)!.keys;
    if (!keys.includes(key) && keys.length < 40) keys.push(key);
  };
  /** `param["key"]` → [param, key] */
  const keyed = (e: Expr): readonly [string, string] | null => {
    if (e.type !== 'Subscript' || e.value.type !== 'Name' || !names.has(e.value.id)) return null;
    const key = text(e.index);
    return key === null ? null : [e.value.id, key];
  };
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const node = n as Expr | Stmt;
    switch (node.type) {
      case 'Subscript': {
        const hit = keyed(node);
        if (hit) addKey(...hit);
        else if (node.value.type === 'Name' && names.has(node.value.id)) {
          const name = node.value.id;
          if (node.index.type === 'List') {
            node.index.elts.forEach((x) => {
              const key = text(x);
              if (key !== null) {
                addKey(name, key);
                info.get(name)!.table += 2;
              }
            });
          } else if (node.index.type === 'Compare' || (node.index.type === 'BinOp' && /[&|]/.test(node.index.op))) info.get(name)!.table += 2;
        }
        break;
      }
      case 'Attribute': {
        if (node.value.type === 'Name' && names.has(node.value.id)) {
          if (TABLE_ATTRS.has(node.attr)) info.get(node.value.id)!.table += 2;
          if (DICT_ATTRS.has(node.attr)) info.get(node.value.id)!.dict += 1;
        }
        const hit = keyed(node.value);
        if (hit && COLUMN_ATTRS.has(node.attr)) info.get(hit[0])!.table += 1;
        break;
      }
      case 'Call': {
        // `param.get("key")`
        if (node.func.type === 'Attribute' && node.func.attr === 'get' && node.func.value.type === 'Name' && names.has(node.func.value.id) && node.args[0]) {
          const key = text(node.args[0]);
          if (key !== null) addKey(node.func.value.id, key);
        }
        break;
      }
      case 'Compare': {
        const hit = keyed(node.left);
        const other = node.comparators[0] ? text(node.comparators[0]) : null;
        if (hit && other !== null && (node.ops[0] === '==' || node.ops[0] === '!=')) {
          const map = info.get(hit[0])!.compared;
          const list = map.get(hit[1]) ?? [];
          if (!list.includes(other)) map.set(hit[1], [...list, other]);
        }
        break;
      }
    }
    for (const [k, x] of Object.entries(node)) if (k !== 'span' && k !== 'headerSpan' && typeof x === 'object') visit(x);
  };
  visit(def.body);

  const out = new Map<string, ParamHint>();
  for (const p of def.params) {
    const i = info.get(p.name);
    if (!i) continue;
    const a = p.annotation ?? '';
    const shape: ParamShape = /DataFrame/.test(a) ? 'table' : /^(dict|Dict|Mapping)\b/.test(a) ? 'dict' : i.table > i.dict ? 'table' : i.dict > 0 || i.keys.length > 0 ? 'dict' : 'value';
    out.set(p.name, { shape, keys: i.keys, compared: i.compared });
  }
  return out;
}

/** Made-up example rows for a table, clearly labelled as such in the interface. */
export function exampleRows(hint: ParamHint, rows = 4): string {
  const cell = (key: string, r: number) => {
    const texts = hint.compared.get(key);
    if (texts && texts.length > 0) return quote(texts[r % texts.length]!);
    return String(r + 1);
  };
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [hint.keys.map(quote).join(','), ...Array.from({ length: rows }, (_, r) => hint.keys.map((k) => cell(k, r)).join(','))].join('\n');
}
