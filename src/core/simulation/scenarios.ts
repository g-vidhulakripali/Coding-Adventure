import { computeLineStarts, positionAt, type Expr, type Module, type Stmt } from '../parser/python/ast';
import type { SourceSpan } from '../source-mapping/types';
import { overrideKey } from './interpreter';
import type { PyValue } from './values';

/**
 * What can be simulated in a file, and which literal values the user may edit.
 * Derived from the syntax tree only — no demo-specific knowledge.
 */

export type ScenarioOption =
  | { readonly id: string; readonly kind: 'script'; readonly path: string; readonly label: string }
  | {
      readonly id: string;
      readonly kind: 'method';
      readonly path: string;
      readonly className: string;
      readonly method: string;
      readonly label: string;
      readonly isProperty: boolean;
      /** Values needed to make the object (`__init__` parameters, without `self`). */
      readonly initParams: ReadonlyArray<{ readonly name: string; readonly defaultValue: PyValue | null }>;
      /** The method's own parameters (without `self`). */
      readonly params: ReadonlyArray<{ readonly name: string; readonly defaultValue: PyValue | null }>;
    }
  | {
      readonly id: string;
      readonly kind: 'function';
      readonly path: string;
      readonly name: string;
      readonly label: string;
      readonly params: ReadonlyArray<{ readonly name: string; readonly defaultValue: PyValue | null }>;
    };

export interface EditableInput {
  /** Override key (path + exact literal span). */
  readonly key: string;
  /** Variable that receives the value, e.g. `prices`. */
  readonly name: string;
  /** How the literal is used, e.g. "list passed to pd.Series(…)". */
  readonly context: string;
  /** Exact original source text of the literal. */
  readonly code: string;
  readonly original: PyValue;
  readonly span: SourceSpan;
}

const DEFINITION_ONLY = new Set(['Import', 'ImportFrom', 'FunctionDef', 'ClassDef', 'Pass']);

function isScriptStatement(s: Stmt): boolean {
  if (DEFINITION_ONLY.has(s.type)) return false;
  if (s.type === 'Expr' && s.isDocstring) return false;
  return true;
}

export function findScenarios(path: string, module: Module): ScenarioOption[] {
  const out: ScenarioOption[] = [];
  if (module.body.some(isScriptStatement)) {
    out.push({ id: `script:${path}`, kind: 'script', path, label: `Run ${path.split('/').pop()} as a script` });
  }
  // Methods of classes: make an object with your values, then run one method on it.
  for (const c of module.body) {
    if (c.type !== 'ClassDef') continue;
    const init = c.body.find((m) => m.type === 'FunctionDef' && m.name === '__init__');
    const initParams = init && init.type === 'FunctionDef' ? init.params.slice(1) : [];
    if (initParams.some((p) => p.kind === 'varargs' || p.kind === 'varkw')) continue;
    for (const m of c.body) {
      if (m.type !== 'FunctionDef' || m.isAsync || m.name.startsWith('_')) continue;
      const decorators = m.decorators.map((d) => module.source.slice(d.span.from, d.span.to));
      const isProperty = decorators.length === 1 && decorators[0] === 'property';
      const isStatic = decorators.length === 1 && decorators[0] === 'staticmethod';
      if (decorators.length > 0 && !isProperty && !isStatic) continue;
      const params = isStatic ? m.params : m.params.slice(1);
      if (params.some((p) => p.kind === 'varargs' || p.kind === 'varkw')) continue;
      out.push({
        id: `method:${path}:${c.name}.${m.name}`,
        kind: 'method',
        path,
        className: c.name,
        method: m.name,
        isProperty,
        label: isProperty ? `Use ${c.name}: read .${m.name}` : `Use ${c.name}: ${m.name}(${params.map((p) => p.name).join(', ')})`,
        initParams: initParams.map((p) => ({ name: p.name, defaultValue: p.defaultValue ? literalValue(p.defaultValue) : null })),
        params: isProperty ? [] : params.map((p) => ({ name: p.name, defaultValue: p.defaultValue ? literalValue(p.defaultValue) : null })),
      });
    }
  }
  for (const s of module.body) {
    if (s.type !== 'FunctionDef' || s.isAsync || s.decorators.length > 0) continue;
    if (s.params.some((p) => p.kind === 'varargs' || p.kind === 'varkw')) continue;
    out.push({
      id: `function:${path}:${s.name}`,
      kind: 'function',
      path,
      name: s.name,
      label: `Call ${s.name}(${s.params.map((p) => p.name).join(', ')})`,
      params: s.params.map((p) => ({ name: p.name, defaultValue: p.defaultValue ? literalValue(p.defaultValue) : null })),
    });
  }
  return out;
}

/** Value of a literal expression (numbers, strings, bools, None, lists/tuples of those), else null. */
export function literalValue(e: Expr): PyValue | null {
  switch (e.type) {
    case 'Constant':
      switch (e.kind) {
        case 'int':
          return { t: 'int', v: e.value as number };
        case 'float':
          return { t: 'float', v: e.value as number };
        case 'str':
          return { t: 'str', v: e.value as string };
        case 'bool':
          return { t: 'bool', v: e.value as boolean };
        case 'none':
          return { t: 'none' };
      }
      return null;
    case 'UnaryOp': {
      if (e.op !== '-' || e.operand.type !== 'Constant') return null;
      const inner = literalValue(e.operand);
      return inner && (inner.t === 'int' || inner.t === 'float') ? { ...inner, v: -inner.v } : null;
    }
    case 'List':
    case 'Tuple': {
      const items: PyValue[] = [];
      for (const elt of e.elts) {
        const value = literalValue(elt);
        if (!value) return null;
        items.push(value);
      }
      return { t: e.type === 'List' ? 'list' : 'tuple', items };
    }
    default:
      return null;
  }
}

/**
 * Literal values assigned at module level (including inside `if` blocks such as
 * `if __name__ == "__main__":`). These are the simulation's editable inputs.
 */
export function findEditableInputs(path: string, module: Module): EditableInput[] {
  const lineStarts = computeLineStarts(module.source);
  const out: EditableInput[] = [];
  const toSpan = (e: Expr): SourceSpan => {
    const start = positionAt(lineStarts, e.span.from);
    const end = positionAt(lineStarts, e.span.to);
    return { path, startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
  };
  const add = (name: string, e: Expr, context: string) => {
    const original = literalValue(e);
    if (!original) return;
    out.push({ key: overrideKey(path, e.span), name, context, code: module.source.slice(e.span.from, e.span.to), original, span: toSpan(e) });
  };
  const visit = (stmts: readonly Stmt[]) => {
    for (const s of stmts) {
      if (s.type === 'If') {
        for (const b of s.branches) visit(b.body);
        if (s.orelse) visit(s.orelse);
        continue;
      }
      if (s.type !== 'Assign' || s.targets.length !== 1 || s.targets[0]!.type !== 'Name') continue;
      const name = s.targets[0].id;
      if (literalValue(s.value)) {
        add(name, s.value, `assigned to ${name}`);
      } else if (s.value.type === 'Call') {
        const callee = module.source.slice(s.value.func.span.from, s.value.func.span.to);
        for (const arg of s.value.args) add(name, arg, `passed to ${callee}(…)`);
      }
    }
  };
  visit(module.body);
  return out;
}
