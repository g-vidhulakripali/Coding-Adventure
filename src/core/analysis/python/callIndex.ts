import { pythonLanguage } from '@codemirror/lang-python';
import type { SyntaxNode } from '@lezer/common';
import { computeLineStarts, positionAt } from '../../parser/python/ast';
import type { SourceSpan } from '../../source-mapping/types';
import type { EvidenceLevel } from '../evidence';

/**
 * Static call index: which functions exist, what each one calls, and where.
 *
 * Built from the syntax tree of every Python file without running anything.
 * Resolution is deliberately conservative:
 *  - `static`   — resolved through a definition in the same file or an explicit import.
 *  - `inferred` — likely target that dynamic dispatch could change (e.g. `self.method()`).
 *  - unresolved — receiver type unknown statically (e.g. `obj.method()` on a parameter).
 * Uncertain relationships are labelled, never invented.
 */

export type DefinitionKind = 'module' | 'function' | 'method' | 'class';

export interface Definition {
  /** `path::qualname`; module scope uses `path::<module>`. */
  readonly id: string;
  readonly kind: DefinitionKind;
  readonly name: string;
  readonly qualname: string;
  readonly path: string;
  /** Span of the definition header (or the first line for module scope). */
  readonly span: SourceSpan;
}

export type CallTarget =
  | { readonly kind: 'internal'; readonly id: string; readonly evidence: Extract<EvidenceLevel, 'static' | 'inferred'>; readonly reason: string }
  | { readonly kind: 'builtin'; readonly name: string }
  | { readonly kind: 'library'; readonly module: string; readonly name: string }
  | { readonly kind: 'unresolved'; readonly reason: string };

export interface CallSite {
  readonly id: string;
  /** Definition (function, method or module scope) containing the call. */
  readonly callerId: string;
  /** Callee as written, e.g. `calculate_total` or `pd.read_csv`. */
  readonly callee: string;
  readonly span: SourceSpan;
  readonly target: CallTarget;
}

export interface CallIndex {
  readonly definitions: readonly Definition[];
  readonly calls: readonly CallSite[];
  /** Files that could not be parsed cleanly (calls may be incomplete there). */
  readonly filesWithSyntaxErrors: readonly string[];
}

const PY_BUILTINS = new Set([
  'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
  'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr',
  'hash', 'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min',
  'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted',
  'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', 'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'RuntimeError', 'NotImplementedError', 'AttributeError', 'StopIteration', 'OSError', 'FileNotFoundError',
]);

type Binding =
  | { kind: 'project-module'; path: string }
  /** `from module import symbol`; `submodule` is set when `module/symbol.py` also exists. */
  | { kind: 'project-symbol'; path: string; symbol: string; submodule: string | null }
  | { kind: 'library'; module: string; symbol: string | null };

interface RawCall {
  callerId: string;
  callee: string;
  span: SourceSpan;
  /** Name for plain calls, or [receiver, attr] for attribute calls. */
  name: string | null;
  receiver: string | null;
  attr: string | null;
  className: string | null;
  path: string;
}

interface FileInfo {
  path: string;
  bindings: Map<string, Binding>;
  /** Top-level names defined in the file → definition id. */
  topLevel: Map<string, string>;
  /** class name → method name → definition id */
  methods: Map<string, Map<string, string>>;
}

export function buildCallIndex(sources: ReadonlyMap<string, string>): CallIndex {
  const definitions: Definition[] = [];
  const raw: RawCall[] = [];
  const files = new Map<string, FileInfo>();
  const filesWithSyntaxErrors: string[] = [];

  for (const [path, source] of sources) {
    const tree = pythonLanguage.parser.parse(source);
    const lineStarts = computeLineStarts(source);
    const text = (n: { from: number; to: number }) => source.slice(n.from, n.to);
    const spanOf = (from: number, to: number): SourceSpan => {
      const a = positionAt(lineStarts, from);
      const b = positionAt(lineStarts, to);
      return { path, startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
    };
    let hasError = false;
    tree.iterate({
      enter(n) {
        if (n.type.isError) hasError = true;
      },
    });
    if (hasError) filesWithSyntaxErrors.push(path);

    const info: FileInfo = { path, bindings: new Map(), topLevel: new Map(), methods: new Map() };
    files.set(path, info);
    const moduleId = `${path}::<module>`;
    const firstLineEnd = source.indexOf('\n') >= 0 ? source.indexOf('\n') : source.length;
    definitions.push({ id: moduleId, kind: 'module', name: path.split('/').pop()!, qualname: '<module>', path, span: spanOf(0, firstLineEnd) });

    const walk = (node: SyntaxNode, scope: { id: string; qualname: string | null; className: string | null; depth: number }) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'FunctionDefinition' || child.name === 'ClassDefinition') {
          const isClass = child.name === 'ClassDefinition';
          const nameNode = child.getChild('VariableName');
          if (!nameNode) continue;
          const name = text(nameNode);
          const qualname = scope.qualname ? `${scope.qualname}.${name}` : name;
          const id = `${path}::${qualname}`;
          const body = child.getChild('Body');
          const headerEnd = body ? body.from : child.to;
          const kind: DefinitionKind = isClass ? 'class' : scope.className && scope.depth === 1 ? 'method' : 'function';
          definitions.push({ id, kind, name, qualname, path, span: spanOf(child.from, headerEnd) });
          if (scope.depth === 0) info.topLevel.set(name, id);
          if (kind === 'method' && scope.className) {
            if (!info.methods.has(scope.className)) info.methods.set(scope.className, new Map());
            info.methods.get(scope.className)!.set(name, id);
          }
          // Decorators and default values run in the enclosing scope; the body runs in the new one.
          for (let c = child.firstChild; c; c = c.nextSibling) {
            // Method bodies keep their class so `self.x()` can be resolved.
            if (c.name === 'Body') walk(c, { id: isClass ? scope.id : id, qualname, className: isClass ? name : kind === 'method' ? scope.className : null, depth: isClass ? 1 : 2 });
            else if (c.name === 'ParamList' || c.name === 'ArgList') walk(c, scope);
          }
          continue;
        }
        if (child.name === 'ImportStatement') {
          recordImport(child, info, text, path, sources);
          continue;
        }
        if (child.name === 'CallExpression') {
          const fn = child.firstChild;
          if (fn) {
            let name: string | null = null;
            let receiver: string | null = null;
            let attr: string | null = null;
            if (fn.name === 'VariableName') name = text(fn);
            else if (fn.name === 'MemberExpression' && fn.getChild('.')) {
              const prop = fn.getChild('PropertyName');
              const recv = fn.firstChild;
              attr = prop ? text(prop) : null;
              receiver = recv ? text(recv) : null;
            }
            raw.push({ callerId: scope.id, callee: text(fn), span: spanOf(child.from, child.to), name, receiver, attr, className: scope.className, path });
          }
        }
        walk(child, scope);
      }
    };
    walk(tree.topNode, { id: moduleId, qualname: null, className: null, depth: 0 });
  }

  const calls: CallSite[] = raw.map((c, i) => ({
    id: `call-${i}`,
    callerId: c.callerId,
    callee: c.callee,
    span: c.span,
    target: resolve(c, files),
  }));
  return { definitions, calls, filesWithSyntaxErrors };
}

function recordImport(node: SyntaxNode, info: FileInfo, text: (n: SyntaxNode) => string, path: string, sources: ReadonlyMap<string, string>) {
  const kids: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name !== 'Comment') kids.push(c);
  const groups = (list: SyntaxNode[]) => {
    const out: SyntaxNode[][] = [[]];
    for (const k of list) {
      if (k.name === ',') out.push([]);
      else if (k.name !== '(' && k.name !== ')') out[out.length - 1]!.push(k);
    }
    return out.filter((g) => g.length);
  };
  const dottedName = (g: SyntaxNode[]) => g.filter((k) => k.name === 'VariableName').map(text).join('.');
  if (kids[0]?.name === 'from') {
    const importIdx = kids.findIndex((k) => k.name === 'import');
    let level = 0;
    const parts: string[] = [];
    for (const k of kids.slice(1, importIdx)) {
      if (k.name === '.' && parts.length === 0) level++;
      else if (k.name === 'VariableName') parts.push(text(k));
    }
    const moduleName = parts.join('.');
    const modulePath = resolveModulePath(moduleName || null, level, path, sources);
    for (const g of groups(kids.slice(importIdx + 1))) {
      const asIdx = g.findIndex((k) => k.name === 'as');
      const name = dottedName(asIdx >= 0 ? g.slice(0, asIdx) : g);
      if (!name || name === '*') continue;
      const local = asIdx >= 0 && g[asIdx + 1] ? text(g[asIdx + 1]!) : name;
      if (modulePath) {
        const sub = modulePath.endsWith('__init__.py') ? resolveModulePath(name, 1, modulePath, sources) : null;
        info.bindings.set(local, { kind: 'project-symbol', path: modulePath, symbol: name, submodule: sub });
      } else {
        info.bindings.set(local, { kind: 'library', module: `${'.'.repeat(level)}${moduleName}`, symbol: name });
      }
    }
    return;
  }
  for (const g of groups(kids.slice(1))) {
    const asIdx = g.findIndex((k) => k.name === 'as');
    const name = dottedName(asIdx >= 0 ? g.slice(0, asIdx) : g);
    if (!name) continue;
    const local = asIdx >= 0 && g[asIdx + 1] ? text(g[asIdx + 1]!) : name.split('.')[0]!;
    const modulePath = resolveModulePath(name, 0, path, sources);
    info.bindings.set(local, modulePath ? { kind: 'project-module', path: modulePath } : { kind: 'library', module: asIdx >= 0 ? name : local, symbol: null });
  }
}

export function resolveModulePath(name: string | null, level: number, fromPath: string, sources: ReadonlyMap<string, string>): string | null {
  const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const parts = name ? name.split('.') : [];
  const bases: string[] = [];
  if (level > 0) {
    let dir = dirname(fromPath);
    for (let i = 1; i < level; i++) dir = dirname(dir);
    bases.push(dir);
  } else {
    // Script directory first (sys.path[0]), then the repository root.
    bases.push(dirname(fromPath), '');
  }
  for (const base of [...new Set(bases)]) {
    const prefix = [base, ...parts].filter(Boolean).join('/');
    const candidates = parts.length ? [`${prefix}.py`, `${prefix}/__init__.py`] : [`${prefix ? prefix + '/' : ''}__init__.py`];
    for (const c of candidates) if (sources.has(c)) return c;
  }
  return null;
}

function resolve(c: RawCall, files: Map<string, FileInfo>): CallTarget {
  const info = files.get(c.path)!;
  if (c.name) {
    const local = info.topLevel.get(c.name);
    if (local) return { kind: 'internal', id: local, evidence: 'static', reason: 'Defined in the same file.' };
    const binding = info.bindings.get(c.name);
    if (binding) return resolveBinding(binding, null, c.name, files);
    if (PY_BUILTINS.has(c.name)) return { kind: 'builtin', name: c.name };
    return { kind: 'unresolved', reason: `\`${c.name}\` is not defined at module level or imported (it may be a local variable or parameter).` };
  }
  if (c.receiver && c.attr) {
    if (c.receiver === 'self' && c.className) {
      const method = info.methods.get(c.className)?.get(c.attr);
      if (method) return { kind: 'internal', id: method, evidence: 'inferred', reason: `Method of ${c.className}; a subclass could override it at runtime.` };
      return { kind: 'unresolved', reason: `\`${c.className}\` defines no method \`${c.attr}\` (it may be inherited or set dynamically).` };
    }
    const binding = info.bindings.get(c.receiver.split('.')[0]!);
    if (binding && !c.receiver.includes('(')) {
      const rest = c.receiver.split('.').slice(1);
      return resolveBinding(binding, [...rest, c.attr].join('.'), c.callee, files);
    }
    const cls = info.topLevel.get(c.receiver);
    if (cls && cls.endsWith(`::${c.receiver}`)) {
      const method = info.methods.get(c.receiver)?.get(c.attr);
      if (method) return { kind: 'internal', id: method, evidence: 'static', reason: `Method looked up on class ${c.receiver}.` };
    }
    return { kind: 'unresolved', reason: `The type of \`${c.receiver}\` is not known statically, so \`.${c.attr}()\` cannot be resolved.` };
  }
  return { kind: 'unresolved', reason: 'The called expression is computed at runtime.' };
}

function resolveBinding(binding: Binding, attrPath: string | null, written: string, files: Map<string, FileInfo>): CallTarget {
  switch (binding.kind) {
    case 'project-symbol': {
      const target = files.get(binding.path);
      // Resolved after every file is indexed: a top-level definition wins over a same-named submodule.
      if (!target?.topLevel.has(binding.symbol) && binding.submodule) {
        return resolveBinding({ kind: 'project-module', path: binding.submodule }, attrPath, written, files);
      }
      const symbolPath = attrPath ? `${binding.symbol}.${attrPath}` : binding.symbol;
      const [head, method] = symbolPath.split('.') as [string, string | undefined];
      const id = method ? target?.methods.get(head)?.get(method) : target?.topLevel.get(head);
      if (id) return { kind: 'internal', id, evidence: 'static', reason: `Imported from ${binding.path}.` };
      return { kind: 'unresolved', reason: `\`${symbolPath}\` is imported from ${binding.path} but its definition was not found there.` };
    }
    case 'project-module': {
      const target = files.get(binding.path);
      if (!attrPath) return { kind: 'unresolved', reason: 'A module object is not callable.' };
      const [head, method] = attrPath.split('.') as [string, string | undefined];
      const id = method ? target?.methods.get(head)?.get(method) : target?.topLevel.get(head);
      if (id) return { kind: 'internal', id, evidence: 'static', reason: `Defined in the imported module ${binding.path}.` };
      return { kind: 'unresolved', reason: `\`${written}\`: no top-level definition \`${attrPath}\` found in ${binding.path}.` };
    }
    case 'library':
      return { kind: 'library', module: binding.module, name: [binding.symbol, attrPath].filter(Boolean).join('.') || binding.module };
  }
}
