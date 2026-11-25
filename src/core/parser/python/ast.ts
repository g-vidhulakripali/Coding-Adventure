import { pythonLanguage } from '@codemirror/lang-python';
import type { SyntaxNode } from '@lezer/common';

/**
 * A small Python AST with exact source offsets.
 *
 * This is the parser abstraction boundary: the simulator, the call index and
 * future analysis passes consume THIS tree, never parser-specific nodes. Phase 1/2
 * builds it from the Lezer Python grammar; Phase 3 can add a Tree-sitter adapter
 * producing the same shapes.
 *
 * Anything the adapter does not understand becomes an explicit `Unsupported`
 * node carrying the reason and its span — nothing is silently dropped.
 */

export interface Span {
  /** Character offsets into the original source; `to` is exclusive. */
  readonly from: number;
  readonly to: number;
}

// ---- Expressions -----------------------------------------------------------

export type Expr =
  | { readonly type: 'Name'; readonly id: string; readonly span: Span }
  | { readonly type: 'Constant'; readonly kind: 'int' | 'float' | 'str' | 'bool' | 'none'; readonly value: number | string | boolean | null; readonly span: Span }
  | { readonly type: 'List' | 'Tuple' | 'Set'; readonly elts: readonly Expr[]; readonly span: Span }
  /** A null key marks `**mapping` spread into the dictionary. */
  | { readonly type: 'Dict'; readonly keys: ReadonlyArray<Expr | null>; readonly values: readonly Expr[]; readonly span: Span }
  /** f-string: literal text and `{expr!conversion:spec}` parts. */
  | { readonly type: 'JoinedStr'; readonly parts: ReadonlyArray<string | FormatPart>; readonly span: Span }
  | { readonly type: 'Comprehension'; readonly kind: 'list' | 'set' | 'dict' | 'generator'; readonly elt: Expr; readonly value: Expr | null; readonly generators: readonly Generator[]; readonly span: Span }
  | { readonly type: 'Lambda'; readonly params: readonly Param[]; readonly body: Expr; readonly span: Span }
  | { readonly type: 'Slice'; readonly lower: Expr | null; readonly upper: Expr | null; readonly step: Expr | null; readonly span: Span }
  | { readonly type: 'Starred'; readonly value: Expr; readonly span: Span }
  | { readonly type: 'NamedExpr'; readonly name: string; readonly value: Expr; readonly span: Span }
  | { readonly type: 'Await' | 'Yield'; readonly value: Expr | null; readonly span: Span }
  | { readonly type: 'Ellipsis'; readonly span: Span }
  | { readonly type: 'BinOp'; readonly op: string; readonly left: Expr; readonly right: Expr; readonly span: Span }
  | { readonly type: 'BoolOp'; readonly op: 'and' | 'or'; readonly left: Expr; readonly right: Expr; readonly span: Span }
  | { readonly type: 'Compare'; readonly left: Expr; readonly ops: readonly string[]; readonly comparators: readonly Expr[]; readonly span: Span }
  | { readonly type: 'UnaryOp'; readonly op: '-' | '+' | 'not' | '~'; readonly operand: Expr; readonly span: Span }
  | { readonly type: 'Call'; readonly func: Expr; readonly args: readonly Expr[]; readonly keywords: readonly Keyword[]; readonly span: Span }
  | { readonly type: 'Attribute'; readonly value: Expr; readonly attr: string; readonly span: Span }
  | { readonly type: 'Subscript'; readonly value: Expr; readonly index: Expr; readonly span: Span }
  | { readonly type: 'IfExp'; readonly test: Expr; readonly body: Expr; readonly orelse: Expr; readonly span: Span }
  | UnsupportedNode;

export interface FormatPart {
  readonly value: Expr;
  readonly conversion: string | null;
  /** Format spec, itself possibly containing replacements (`{x:.{n}f}`). */
  readonly spec: ReadonlyArray<string | FormatPart> | null;
  /** Text before `=` for the self-documenting form `{x=}`. */
  readonly selfDoc: string | null;
}

export interface Generator {
  readonly target: Expr;
  readonly iter: Expr;
  readonly ifs: readonly Expr[];
}

export interface Keyword {
  /** null for `**mapping`. */
  readonly name: string | null;
  readonly value: Expr;
  readonly span: Span;
}

export interface UnsupportedNode {
  readonly type: 'Unsupported';
  /** Parser node name, e.g. `LambdaExpression`. */
  readonly node: string;
  readonly reason: string;
  readonly span: Span;
}

// ---- Statements -------------------------------------------------------------

export interface Param {
  readonly name: string;
  readonly kind: 'positional' | 'varargs' | 'kwonly' | 'varkw';
  readonly defaultValue: Expr | null;
  /** Type annotation as written, if any. */
  readonly annotation?: string;
  readonly span: Span;
}

export interface ImportName {
  readonly name: string;
  readonly asname: string | null;
  readonly span: Span;
}

export interface IfBranch {
  readonly test: Expr;
  readonly body: readonly Stmt[];
  /** Span of the `if`/`elif` header up to the colon. */
  readonly span: Span;
}

export type Stmt =
  | { readonly type: 'Assign'; readonly targets: readonly Expr[]; readonly value: Expr; readonly span: Span }
  | { readonly type: 'AugAssign'; readonly target: Expr; readonly op: string; readonly value: Expr; readonly span: Span }
  | { readonly type: 'Expr'; readonly value: Expr; readonly isDocstring: boolean; readonly span: Span }
  | { readonly type: 'Return'; readonly value: Expr | null; readonly span: Span }
  | { readonly type: 'If'; readonly branches: readonly IfBranch[]; readonly orelse: readonly Stmt[] | null; readonly elseSpan: Span | null; readonly span: Span }
  | { readonly type: 'For'; readonly target: Expr; readonly iter: Expr; readonly body: readonly Stmt[]; readonly orelse: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | { readonly type: 'While'; readonly test: Expr; readonly body: readonly Stmt[]; readonly orelse: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | { readonly type: 'With'; readonly items: ReadonlyArray<{ readonly context: Expr; readonly target: Expr | null }>; readonly body: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | { readonly type: 'Try'; readonly body: readonly Stmt[]; readonly handlers: readonly Handler[]; readonly orelse: readonly Stmt[]; readonly finalbody: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span; readonly elseSpan: Span | null; readonly finallySpan: Span | null }
  | { readonly type: 'Raise'; readonly exc: Expr | null; readonly span: Span }
  | { readonly type: 'Assert'; readonly test: Expr; readonly message: Expr | null; readonly span: Span }
  | { readonly type: 'Delete'; readonly targets: readonly Expr[]; readonly span: Span }
  | { readonly type: 'Scope'; readonly names: readonly string[]; readonly span: Span }
  /** `name: type` without a value. */
  | { readonly type: 'Declare'; readonly name: string | null; readonly span: Span }
  | FunctionDef
  | { readonly type: 'ClassDef'; readonly name: string; readonly bases: readonly Expr[]; readonly decorators: readonly Expr[]; readonly body: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | { readonly type: 'Import'; readonly names: readonly ImportName[]; readonly span: Span }
  | { readonly type: 'ImportFrom'; readonly module: string | null; readonly level: number; readonly names: readonly ImportName[]; readonly span: Span }
  | { readonly type: 'Pass' | 'Break' | 'Continue'; readonly span: Span }
  | UnsupportedNode;

export interface Handler {
  readonly exc: Expr | null;
  readonly name: string | null;
  readonly body: readonly Stmt[];
  readonly span: Span;
}

export interface FunctionDef {
  readonly type: 'FunctionDef';
  readonly name: string;
  readonly params: readonly Param[];
  readonly body: readonly Stmt[];
  readonly decorators: readonly Expr[];
  readonly isAsync: boolean;
  /** `def name(params) -> ret:` header. */
  readonly headerSpan: Span;
  readonly span: Span;
}

export interface Module {
  readonly type: 'Module';
  readonly body: readonly Stmt[];
  readonly source: string;
  /** Offsets of syntax-error regions the parser recovered from. */
  readonly syntaxErrors: readonly Span[];
}

// ---- Conversion ---------------------------------------------------------------

const SKIP = new Set(['Comment', '(', ')', '[', ']', '{', '}', ',', ':', '.']);

/** Recently parsed sources. Modules are immutable, so every reader can share them. */
const parseCache = new Map<string, Module>();
const PARSE_CACHE_LIMIT = 600;

export function parsePythonModule(source: string): Module {
  const hit = parseCache.get(source);
  if (hit) return hit;
  const module = parseModule(source);
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.delete(parseCache.keys().next().value!);
  parseCache.set(source, module);
  return module;
}

function parseModule(source: string): Module {
  const tree = pythonLanguage.parser.parse(source);
  const syntaxErrors: Span[] = [];
  tree.iterate({
    enter(node) {
      if (node.type.isError) syntaxErrors.push({ from: node.from, to: node.to });
    },
  });
  const converter = new Converter(source);
  return { type: 'Module', body: converter.block(tree.topNode, true), source, syntaxErrors };
}

function kids(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'Comment') out.push(c);
  }
  return out;
}

function spanOf(node: SyntaxNode): Span {
  return { from: node.from, to: node.to };
}

/** Splits children into comma-separated groups, ignoring brackets. */
function commaGroups(children: SyntaxNode[]): SyntaxNode[][] {
  const groups: SyntaxNode[][] = [[]];
  for (const c of children) {
    if (c.name === ',') groups.push([]);
    else if (c.name !== '(' && c.name !== ')' && c.name !== '[' && c.name !== ']' && c.name !== '{' && c.name !== '}') groups[groups.length - 1]!.push(c);
  }
  return groups.filter((g) => g.length > 0);
}

const COMPARE_OPS = new Set(['<', '>', '<=', '>=', '==', '!=', 'is', 'is not', 'in', 'not in']);

class Converter {
  constructor(private readonly src: string) {}

  private text(node: SyntaxNode | Span): string {
    return this.src.slice(node.from, node.to);
  }

  private unsupported(node: SyntaxNode, reason: string): UnsupportedNode {
    return { type: 'Unsupported', node: node.name, reason, span: spanOf(node) };
  }

  /** Statements of a Script or Body node. */
  block(node: SyntaxNode, isModuleOrFn: boolean): Stmt[] {
    const out: Stmt[] = [];
    for (const child of kids(node)) {
      if (child.name === ':' || child.name === 'Comment') continue;
      const stmt = this.stmt(child);
      if (stmt) out.push(stmt);
    }
    // Mark docstrings: a leading string expression in a module, function or class body.
    if (isModuleOrFn && out[0]?.type === 'Expr' && out[0].value.type === 'Constant' && out[0].value.kind === 'str') {
      out[0] = { ...out[0], isDocstring: true };
    }
    return out;
  }

  private body(node: SyntaxNode | null): Stmt[] {
    return node ? this.block(node, false) : [];
  }

  stmt(node: SyntaxNode): Stmt | null {
    const span = spanOf(node);
    if (node.type.isError) return this.unsupported(node, 'Syntax error: the parser could not read this code.');
    switch (node.name) {
      case 'ExpressionStatement': {
        const e = kids(node)[0];
        return { type: 'Expr', value: e ? this.expr(e) : this.unsupported(node, 'Empty expression'), isDocstring: false, span };
      }
      case 'AssignStatement':
        return this.assign(node);
      case 'UpdateStatement': {
        const [target, op, value] = kids(node);
        if (!target || !op || !value) return this.unsupported(node, 'Malformed augmented assignment');
        return { type: 'AugAssign', target: this.expr(target), op: this.text(op).replace('=', ''), value: this.expr(value), span };
      }
      case 'ReturnStatement': {
        const value = kids(node).filter((c) => c.name !== 'return');
        if (value.some((c) => c.name === ',' || c.name === '*')) {
          return { type: 'Return', value: { type: 'Tuple', elts: this.elements(value), span: { from: value[0]!.from, to: value[value.length - 1]!.to } }, span };
        }
        return { type: 'Return', value: value[0] ? this.expr(value[0]) : null, span };
      }
      case 'IfStatement':
        return this.ifStmt(node);
      case 'ForStatement': {
        const c = kids(node);
        const inIdx = c.findIndex((k) => k.name === 'in');
        const body = c.find((k) => k.name === 'Body') ?? null;
        const orelseBody = c.filter((k) => k.name === 'Body')[1] ?? null;
        const targets = c.slice(c[0]?.name === 'async' ? 2 : 1, inIdx).filter((k) => k.name !== ',');
        const iterNode = c.slice(inIdx + 1).find((k) => k.name !== 'Body');
        if (inIdx < 0 || !iterNode || targets.length === 0) return this.unsupported(node, 'Malformed for loop');
        const target = targets.length === 1 ? this.expr(targets[0]!) : this.tupleFrom(node, targets);
        return {
          type: 'For',
          target,
          iter: this.expr(iterNode),
          body: this.body(body),
          orelse: this.body(orelseBody),
          headerSpan: { from: node.from, to: body ? body.from + 1 : node.to },
          span,
        };
      }
      case 'WhileStatement': {
        const c = kids(node);
        const test = c[1];
        const body = c.find((k) => k.name === 'Body') ?? null;
        if (!test) return this.unsupported(node, 'Malformed while loop');
        return { type: 'While', test: this.expr(test), body: this.body(body), orelse: this.body(c.filter((k) => k.name === 'Body')[1] ?? null), headerSpan: { from: node.from, to: body ? body.from + 1 : node.to }, span };
      }
      case 'FunctionDefinition':
        return this.functionDef(node, [], node);
      case 'ClassDefinition':
        return this.classDef(node, [], node);
      case 'DecoratedStatement': {
        const decorators = kids(node)
          .filter((c) => c.name === 'Decorator')
          .map((d) => {
            // Lezer splits `@a.b(…)` into flat tokens; only its text is needed, so keep the whole span.
            const parts = kids(d).filter((k) => k.name !== 'At');
            const first = parts[0];
            if (!first) return this.unsupported(d, 'Empty decorator');
            const span = { from: first.from, to: parts[parts.length - 1]!.to };
            return { type: 'Name' as const, id: this.src.slice(span.from, span.to), span };
          });
        const fn = node.getChild('FunctionDefinition');
        if (fn) return this.functionDef(fn, decorators, node);
        const cls = node.getChild('ClassDefinition');
        if (cls) return this.classDef(cls, decorators, node);
        return this.unsupported(node, 'Unknown decorated statement');
      }
      case 'ImportStatement':
        return this.importStmt(node);
      case 'WithStatement':
        return this.withStmt(node);
      case 'TryStatement':
        return this.tryStmt(node);
      case 'RaiseStatement': {
        const e = kids(node)[1];
        return { type: 'Raise', exc: e ? this.expr(e) : null, span };
      }
      case 'AssertStatement': {
        const parts = kids(node).slice(1).filter((k) => k.name !== ',');
        if (!parts[0]) return this.unsupported(node, 'Malformed assert');
        return { type: 'Assert', test: this.expr(parts[0]), message: parts[1] ? this.expr(parts[1]) : null, span };
      }
      case 'DeleteStatement':
        return { type: 'Delete', targets: kids(node).slice(1).filter((k) => k.name !== ',').map((k) => this.expr(k)), span };
      case 'ScopeStatement':
        return { type: 'Scope', names: kids(node).filter((k) => k.name === 'VariableName').map((k) => this.text(k)), span };
      case 'YieldStatement': {
        const e = kids(node).slice(1).find((k) => k.name !== 'from');
        return { type: 'Expr', value: { type: 'Yield', value: e ? this.expr(e) : null, span }, isDocstring: false, span };
      }
      case 'PassStatement':
        return { type: 'Pass', span };
      case 'BreakStatement':
        return { type: 'Break', span };
      case 'ContinueStatement':
        return { type: 'Continue', span };
      default:
        return this.unsupported(node, `\`${node.name.replace(/Statement$/, '').toLowerCase()}\` statements are not supported yet.`);
    }
  }

  private assign(node: SyntaxNode): Stmt {
    const c = kids(node);
    if (c.some((k) => k.name === 'TypeDef') && !c.some((k) => k.name === 'AssignOp')) {
      const name = c[0]?.name === 'VariableName' ? this.text(c[0]) : null;
      return { type: 'Declare', name, span: spanOf(node) };
    }
    const segments: SyntaxNode[][] = [[]];
    for (const k of c) {
      if (k.name === 'AssignOp') segments.push([]);
      else if (k.name !== 'TypeDef') segments[segments.length - 1]!.push(k);
    }
    const exprs = segments.map((seg) => {
      const trailingComma = seg.length > 0 && seg[seg.length - 1]!.name === ',';
      const parts = this.elements(seg);
      if (parts.length === 1 && !trailingComma && !seg.some((x) => x.name === '*')) return parts[0]!;
      if (parts.length === 0) return this.unsupported(node, 'Empty assignment');
      return { type: 'Tuple', elts: parts, span: { from: seg[0]!.from, to: seg[seg.length - 1]!.to } } as Expr;
    });
    const value = exprs.pop();
    if (!value || exprs.length === 0) return this.unsupported(node, 'Malformed assignment');
    return { type: 'Assign', targets: exprs, value, span: spanOf(node) };
  }

  /** Comma-separated elements, where `*x` becomes a Starred element. */
  private elements(children: readonly SyntaxNode[]): Expr[] {
    return commaGroups([...children]).map((g) => {
      if (g[0]!.name === '*' && g[1]) return { type: 'Starred', value: this.expr(g[1]), span: { from: g[0]!.from, to: g[1].to } } as Expr;
      return this.expr(g[0]!);
    });
  }

  private withStmt(node: SyntaxNode): Stmt {
    const all = kids(node);
    const body = all.find((k) => k.name === 'Body') ?? null;
    const start = all.findIndex((k) => k.name === 'with') + 1;
    const items = commaGroups(all.slice(start).filter((k) => k.name !== 'Body')).map((g) => {
      const as = g.findIndex((k) => k.name === 'as');
      return { context: this.expr(g[0]!), target: as >= 0 && g[as + 1] ? this.expr(g[as + 1]!) : null };
    });
    return { type: 'With', items, body: this.body(body), headerSpan: { from: node.from, to: body ? body.from + 1 : node.to }, span: spanOf(node) };
  }

  private tryStmt(node: SyntaxNode): Stmt {
    const c = kids(node);
    let body: Stmt[] = [];
    let orelse: Stmt[] = [];
    let finalbody: Stmt[] = [];
    let elseSpan: Span | null = null;
    let finallySpan: Span | null = null;
    let headerTo = node.to;
    const handlers: Handler[] = [];
    for (let i = 0; i < c.length; i++) {
      const k = c[i]!;
      if (!['try', 'except', 'else', 'finally'].includes(k.name)) continue;
      const bodyIdx = c.findIndex((x, j) => j > i && x.name === 'Body');
      const b = c[bodyIdx];
      if (!b) continue;
      const header = { from: k.from, to: b.from + 1 };
      const stmts = this.body(b);
      if (k.name === 'try') {
        body = stmts;
        headerTo = b.from + 1;
      } else if (k.name === 'else') {
        orelse = stmts;
        elseSpan = header;
      } else if (k.name === 'finally') {
        finalbody = stmts;
        finallySpan = header;
      } else {
        const between = c.slice(i + 1, bodyIdx).filter((x) => x.name !== '*');
        const as = between.findIndex((x) => x.name === 'as');
        const exc = between[0] && between[0].name !== 'as' ? this.expr(between[0]) : null;
        handlers.push({ exc, name: as >= 0 && between[as + 1] ? this.text(between[as + 1]!) : null, body: stmts, span: header });
      }
      i = bodyIdx;
    }
    return { type: 'Try', body, handlers, orelse, finalbody, headerSpan: { from: node.from, to: headerTo }, span: spanOf(node), elseSpan, finallySpan };
  }

  private tupleFrom(owner: SyntaxNode, parts: SyntaxNode[]): Expr {
    if (parts.length === 0) return this.unsupported(owner, 'Empty tuple');
    return { type: 'Tuple', elts: parts.map((p) => this.expr(p)), span: { from: parts[0]!.from, to: parts[parts.length - 1]!.to } };
  }

  private ifStmt(node: SyntaxNode): Stmt {
    const c = kids(node);
    const branches: IfBranch[] = [];
    let orelse: Stmt[] | null = null;
    let elseSpan: Span | null = null;
    for (let i = 0; i < c.length; i++) {
      const k = c[i]!;
      if (k.name === 'if' || k.name === 'elif') {
        const test = c[i + 1];
        const body = c[i + 2];
        if (!test || !body || body.name !== 'Body') return this.unsupported(node, 'Malformed if statement');
        branches.push({ test: this.expr(test), body: this.body(body), span: { from: k.from, to: body.from + 1 } });
        i += 2;
      } else if (k.name === 'else') {
        const body = c[i + 1];
        if (!body) return this.unsupported(node, 'Malformed else');
        orelse = this.body(body);
        elseSpan = { from: k.from, to: body.from + 1 };
        i += 1;
      }
    }
    return { type: 'If', branches, orelse, elseSpan, span: spanOf(node) };
  }

  private functionDef(node: SyntaxNode, decorators: Expr[], outer: SyntaxNode): Stmt {
    const name = node.getChild('VariableName');
    const paramList = node.getChild('ParamList');
    const body = node.getChild('Body');
    if (!name || !paramList) return this.unsupported(node, 'Malformed function definition');
    const params = this.params(paramList);
    return {
      type: 'FunctionDef',
      name: this.text(name),
      params,
      body: body ? this.block(body, true) : [],
      decorators,
      isAsync: node.getChild('async') !== null,
      headerSpan: { from: node.from, to: body ? body.from + 1 : node.to },
      span: spanOf(outer),
    };
  }

  private params(paramList: SyntaxNode): Param[] {
    const params: Param[] = [];
    let kind: Param['kind'] = 'positional';
    for (const group of commaGroups(kids(paramList))) {
      const head = group[0]!;
      if (head.name === '*' || head.name === '**') {
        const n = group.find((g) => g.name === 'VariableName');
        if (head.name === '*' && !n) {
          kind = 'kwonly';
          continue;
        }
        if (!n) continue;
        params.push({ name: this.text(n), kind: head.name === '*' ? 'varargs' : 'varkw', defaultValue: null, span: { from: head.from, to: n.to } });
        if (head.name === '*') kind = 'kwonly';
        continue;
      }
      if (head.name === '/') continue; // positional-only marker: no effect on our binding model
      if (head.name !== 'VariableName') continue;
      const eq = group.findIndex((g) => g.name === 'AssignOp');
      const defaultNode = eq >= 0 ? group[eq + 1] : undefined;
      const typeDef = group.find((g) => g.name === 'TypeDef');
      params.push({
        name: this.text(head),
        kind,
        defaultValue: defaultNode ? this.expr(defaultNode) : null,
        ...(typeDef ? { annotation: this.text(typeDef).replace(/^:\s*/, '') } : {}),
        span: { from: head.from, to: group[group.length - 1]!.to },
      });
    }
    return params;
  }

  private classDef(node: SyntaxNode, decorators: Expr[], outer: SyntaxNode): Stmt {
    const name = node.getChild('VariableName');
    const args = node.getChild('ArgList');
    const body = node.getChild('Body');
    if (!name) return this.unsupported(node, 'Malformed class definition');
    return {
      type: 'ClassDef',
      name: this.text(name),
      // Keyword arguments such as `metaclass=…` are not base classes.
      bases: args ? commaGroups(kids(args)).filter((g) => !g.some((k) => k.name === 'AssignOp')).map((g) => this.expr(g[0]!)) : [],
      decorators,
      body: body ? this.block(body, true) : [],
      headerSpan: { from: node.from, to: body ? body.from + 1 : node.to },
      span: spanOf(outer),
    };
  }

  private importStmt(node: SyntaxNode): Stmt {
    const c = kids(node);
    const span = spanOf(node);
    if (c[0]?.name === 'from') {
      const importIdx = c.findIndex((k) => k.name === 'import');
      let level = 0;
      const moduleParts: string[] = [];
      for (const k of c.slice(1, importIdx)) {
        if (k.name === '.' && moduleParts.length === 0) level++;
        else if (k.name === 'Ellipsis' || this.text(k) === '...') level += 3;
        else if (k.name === 'VariableName') moduleParts.push(this.text(k));
      }
      const rest = c.slice(importIdx + 1).filter((k) => k.name !== '(' && k.name !== ')');
      if (rest.some((k) => k.name === '*')) return this.unsupported(node, '`from … import *` cannot be resolved statically.');
      return { type: 'ImportFrom', module: moduleParts.length ? moduleParts.join('.') : null, level, names: this.importNames(rest), span };
    }
    return { type: 'Import', names: this.importNames(c.slice(1)), span };
  }

  /** `a.b as c, d` → names. Dotted names arrive as VariableName . VariableName sequences. */
  private importNames(nodes: SyntaxNode[]): ImportName[] {
    const names: ImportName[] = [];
    for (const group of commaGroups(nodes)) {
      const asIdx = group.findIndex((g) => g.name === 'as');
      const nameParts = (asIdx >= 0 ? group.slice(0, asIdx) : group).filter((g) => g.name === 'VariableName');
      const alias = asIdx >= 0 ? group[asIdx + 1] : undefined;
      if (nameParts.length === 0) continue;
      names.push({
        name: nameParts.map((p) => this.text(p)).join('.'),
        asname: alias ? this.text(alias) : null,
        span: { from: group[0]!.from, to: group[group.length - 1]!.to },
      });
    }
    return names;
  }

  expr(node: SyntaxNode): Expr {
    const span = spanOf(node);
    if (node.type.isError) return this.unsupported(node, 'Syntax error: the parser could not read this code.');
    // An expression containing a recovered syntax error cannot be trusted.
    let hasError = false;
    node.cursor().iterate((n) => {
      if (n.type.isError) hasError = true;
    });
    if (hasError) return this.unsupported(node, 'Syntax error inside this expression.');

    switch (node.name) {
      case 'VariableName':
        return { type: 'Name', id: this.text(node), span };
      case 'Number':
        return this.number(node);
      case 'String':
        return this.string(node);
      case 'ContinuedString': {
        // Implicit concatenation: "a" "b" f"{c}"
        const parts: Array<string | FormatPart> = [];
        for (const part of kids(node)) {
          const e = part.name === 'FormatString' ? this.formatString(part) : this.string(part);
          if (e.type === 'JoinedStr') parts.push(...e.parts);
          else if (e.type === 'Constant') parts.push(String(e.value));
          else return e;
        }
        if (parts.every((x) => typeof x === 'string')) return { type: 'Constant', kind: 'str', value: parts.join(''), span };
        return { type: 'JoinedStr', parts, span };
      }
      case 'FormatString':
        return this.formatString(node);
      case 'Boolean':
        return { type: 'Constant', kind: 'bool', value: this.text(node) === 'True', span };
      case 'None':
        return { type: 'Constant', kind: 'none', value: null, span };
      case 'ArrayExpression':
        return { type: 'List', elts: this.elements(kids(node)), span };
      case 'TupleExpression':
        return { type: 'Tuple', elts: this.elements(kids(node)), span };
      case 'SetExpression':
        return { type: 'Set', elts: this.elements(kids(node)), span };
      case 'NamedExpression': {
        const c = kids(node);
        return { type: 'NamedExpr', name: this.text(c[0]!), value: this.expr(c[c.length - 1]!), span };
      }
      case 'Ellipsis':
        return { type: 'Ellipsis', span };
      case 'YieldExpression': {
        const e = kids(node).slice(1).find((k) => k.name !== 'from');
        return { type: 'Yield', value: e ? this.expr(e) : null, span };
      }
      case 'ParenthesizedExpression': {
        const inner = kids(node).find((k) => !SKIP.has(k.name));
        if (!inner) return this.unsupported(node, 'Empty parentheses');
        // Keep the inner node but widen its span to include the parentheses.
        return Object.assign({}, this.expr(inner), { span, parenthesized: true }) as Expr;
      }
      case 'DictionaryExpression': {
        const keys: Array<Expr | null> = [];
        const values: Expr[] = [];
        for (const group of commaGroups(kids(node))) {
          if (group[0]!.name === '**' && group[1]) {
            keys.push(null);
            values.push(this.expr(group[1]));
            continue;
          }
          const colon = group.findIndex((g) => g.name === ':');
          if (colon !== 1 || group.length !== 3) return this.unsupported(node, 'Only simple `key: value` dictionaries are supported.');
          keys.push(this.expr(group[0]!));
          values.push(this.expr(group[2]!));
        }
        return { type: 'Dict', keys, values, span };
      }
      case 'UnaryExpression': {
        const [opNode, operandNode] = kids(node);
        if (!opNode || !operandNode) return this.unsupported(node, 'Malformed unary expression');
        if (opNode.name === 'not') return this.boolean(node);
        return { type: 'UnaryOp', op: this.text(opNode) as '-' | '+' | '~', operand: this.expr(operandNode), span };
      }
      case 'BinaryExpression':
        return this.binary(node);
      case 'CallExpression':
        return this.call(node);
      case 'MemberExpression':
        return this.member(node);
      case 'ConditionalExpression': {
        const c = kids(node);
        const ifIdx = c.findIndex((k) => k.name === 'if');
        const elseIdx = c.findIndex((k) => k.name === 'else');
        if (ifIdx !== 1 || elseIdx < 0 || !c[0] || !c[ifIdx + 1] || !c[elseIdx + 1]) return this.unsupported(node, 'Malformed conditional expression');
        return { type: 'IfExp', body: this.expr(c[0]), test: this.expr(c[ifIdx + 1]!), orelse: this.expr(c[elseIdx + 1]!), span };
      }
      case 'LambdaExpression': {
        const list = node.getChild('ParamList');
        const body = node.lastChild;
        if (!body) return this.unsupported(node, 'Malformed lambda');
        return { type: 'Lambda', params: list ? this.params(list) : [], body: this.expr(body), span };
      }
      case 'ArrayComprehensionExpression':
        return this.comprehension(node, 'list');
      case 'DictionaryComprehensionExpression':
        return this.comprehension(node, 'dict');
      case 'SetComprehensionExpression':
        return this.comprehension(node, 'set');
      case 'ComprehensionExpression':
        return this.comprehension(node, 'generator');
      case 'AwaitExpression': {
        const e = node.lastChild;
        return { type: 'Await', value: e ? this.expr(e) : null, span };
      }
      default:
        return this.unsupported(node, `\`${node.name}\` expressions are not supported yet.`);
    }
  }

  /**
   * `not` / `and` / `or` with Python's precedence. Lezer groups `not a or b` as
   * `not (a or b)`, so unparenthesised chains are flattened and regrouped here.
   */
  private boolean(node: SyntaxNode): Expr {
    type Token = { op: 'and' | 'or' | 'not'; from: number } | { atom: Expr };
    const tokens: Token[] = [];
    const flatten = (n: SyntaxNode) => {
      const c = kids(n);
      if (n.name === 'UnaryExpression' && c[0]?.name === 'not' && c[1]) {
        tokens.push({ op: 'not', from: c[0].from });
        flatten(c[1]);
        return;
      }
      const op = n.name === 'BinaryExpression' ? c.find((k) => k.name === 'and' || k.name === 'or') : undefined;
      if (op && c[0] && c.length === 3) {
        flatten(c[0]);
        tokens.push({ op: op.name as 'and' | 'or', from: op.from });
        flatten(c[2]!);
        return;
      }
      tokens.push({ atom: this.expr(n) });
    };
    flatten(node);
    let pos = 0;
    const peek = (op: string) => {
      const t = tokens[pos];
      return t !== undefined && 'op' in t && t.op === op;
    };
    const unary = (): Expr => {
      const t = tokens[pos++];
      if (t && 'op' in t) {
        const operand = unary();
        return { type: 'UnaryOp', op: 'not', operand, span: { from: t.from, to: operand.span.to } };
      }
      return t ? t.atom : this.unsupported(node, 'Malformed boolean expression');
    };
    const level = (op: 'and' | 'or', next: () => Expr): Expr => {
      let left = next();
      while (peek(op)) {
        pos++;
        const right = next();
        left = { type: 'BoolOp', op, left, right, span: { from: left.span.from, to: right.span.to } };
      }
      return left;
    };
    return level('or', () => level('and', unary));
  }

  /** `elt for target in iter if cond …`, for all four comprehension kinds. */
  private comprehension(node: SyntaxNode, kind: 'list' | 'set' | 'dict' | 'generator'): Expr {
    const inner = kids(node).filter((k) => !['(', ')', '[', ']', '{', '}'].includes(k.name));
    const firstFor = inner.findIndex((k) => k.name === 'for');
    const head = inner.slice(0, firstFor).filter((k) => k.name !== 'async');
    if (firstFor < 1 || !head[0]) return this.unsupported(node, 'Malformed comprehension');
    const colon = head.findIndex((k) => k.name === ':');
    const generators: Generator[] = [];
    let i = firstFor;
    while (i < inner.length) {
      if (inner[i]!.name === 'async') {
        i++;
        continue;
      }
      const inAt = inner.findIndex((k, j) => j > i && k.name === 'in');
      const targets = this.elements(inner.slice(i + 1, inAt));
      const iterNode = inner[inAt + 1];
      if (inAt < 0 || !iterNode || targets.length === 0) return this.unsupported(node, 'Malformed comprehension');
      const target: Expr = targets.length === 1 ? targets[0]! : { type: 'Tuple', elts: targets, span: { from: targets[0]!.span.from, to: targets[targets.length - 1]!.span.to } };
      const ifs: Expr[] = [];
      i = inAt + 2;
      while (inner[i]?.name === 'if' && inner[i + 1]) {
        ifs.push(this.expr(inner[i + 1]!));
        i += 2;
      }
      generators.push({ target, iter: this.expr(iterNode), ifs });
      if (i < inner.length && inner[i]!.name !== 'for' && inner[i]!.name !== 'async') return this.unsupported(node, 'Malformed comprehension');
    }
    return {
      type: 'Comprehension',
      kind,
      elt: this.expr(head[0]),
      value: kind === 'dict' && colon >= 0 && head[colon + 1] ? this.expr(head[colon + 1]!) : null,
      generators,
      span: spanOf(node),
    };
  }

  private formatString(node: SyntaxNode): Expr {
    const raw = this.text(node);
    const open = /^([a-zA-Z]*)('''|"""|'|")/.exec(raw);
    if (!open) return this.unsupported(node, 'Unrecognised f-string');
    const isRaw = open[1]!.toLowerCase().includes('r');
    const parts = this.formatParts(node, node.from + open[0].length, node.to - open[2]!.length, isRaw);
    return parts ? { type: 'JoinedStr', parts, span: spanOf(node) } : this.unsupported(node, 'Unsupported escape sequence in f-string');
  }

  private formatParts(node: SyntaxNode, from: number, to: number, isRaw: boolean): Array<string | FormatPart> | null {
    const parts: Array<string | FormatPart> = [];
    const literal = (a: number, b: number) => {
      const text = this.src.slice(a, b).replace(/\{\{/g, '{').replace(/\}\}/g, '}');
      const value = isRaw ? text : decodeEscapes(text);
      if (value) parts.push(value);
      return value !== null;
    };
    let pos = from;
    for (const r of kids(node).filter((k) => k.name === 'FormatReplacement')) {
      if (!literal(pos, r.from)) return null;
      const c = kids(r);
      const value = c.find((k) => !['{', '}', 'FormatConversion', 'FormatSpec', 'FormatSelfDoc'].includes(k.name));
      if (!value) return null;
      const conv = c.find((k) => k.name === 'FormatConversion');
      const spec = c.find((k) => k.name === 'FormatSpec');
      const doc = c.find((k) => k.name === 'FormatSelfDoc');
      const rest = value.name === ',' ? [] : this.elements(c.slice(1).filter((k) => !['}', 'FormatConversion', 'FormatSpec', 'FormatSelfDoc'].includes(k.name)));
      const expr: Expr = rest.length > 1 ? { type: 'Tuple', elts: rest, span: { from: rest[0]!.span.from, to: rest[rest.length - 1]!.span.to } } : this.expr(value);
      const specParts = spec ? this.formatParts(spec, spec.from + 1, spec.to, isRaw) : null;
      parts.push({ value: expr, conversion: conv ? this.text(conv).slice(1) : null, spec: specParts, selfDoc: doc ? this.src.slice(value.from, doc.to) : null });
      pos = r.to;
    }
    return literal(pos, to) ? parts : null;
  }

  private number(node: SyntaxNode): Expr {
    const raw = this.text(node).replace(/_/g, '');
    const span = spanOf(node);
    if (/[jJ]$/.test(raw)) return this.unsupported(node, 'Complex numbers are not simulated.');
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return { type: 'Constant', kind: 'int', value: parseInt(raw.slice(2), 16), span };
    if (/^0[oO][0-7]+$/.test(raw)) return { type: 'Constant', kind: 'int', value: parseInt(raw.slice(2), 8), span };
    if (/^0[bB][01]+$/.test(raw)) return { type: 'Constant', kind: 'int', value: parseInt(raw.slice(2), 2), span };
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) return this.unsupported(node, 'Integer too large for exact simulation.');
      return { type: 'Constant', kind: 'int', value, span };
    }
    const value = Number(raw);
    if (Number.isNaN(value)) return this.unsupported(node, `Unrecognised number \`${raw}\``);
    return { type: 'Constant', kind: 'float', value, span };
  }

  private string(node: SyntaxNode): Expr {
    const raw = this.text(node);
    const match = /^([a-zA-Z]*)('''|"""|'|")([\s\S]*)\2$/.exec(raw);
    if (!match) return this.unsupported(node, 'Unrecognised string literal');
    const prefix = match[1]!.toLowerCase();
    if (prefix.includes('b')) return this.unsupported(node, 'Bytes literals are not simulated.');
    if (prefix.includes('f')) return this.unsupported(node, 'f-strings are not simulated yet.');
    const body = match[3]!;
    const value = prefix.includes('r') ? body : decodeEscapes(body);
    if (value === null) return this.unsupported(node, 'Unsupported escape sequence in string');
    return { type: 'Constant', kind: 'str', value, span: spanOf(node) };
  }

  private binary(node: SyntaxNode): Expr {
    const c = kids(node);
    const leftNode = c[0];
    const rightNode = c[c.length - 1];
    if (!leftNode || !rightNode || c.length < 3) return this.unsupported(node, 'Malformed binary expression');
    const op = this.src.slice(leftNode.to, rightNode.from).trim().replace(/\s+/g, ' ');
    if (op === 'and' || op === 'or') return this.boolean(node);
    const left = this.expr(leftNode);
    const right = this.expr(rightNode);
    const span = spanOf(node);
    if (COMPARE_OPS.has(op)) {
      // Lezer nests chains as ((a < b) <= c); Python means a < b and b <= c.
      if (left.type === 'Compare' && !isParenthesized(left)) {
        return { type: 'Compare', left: left.left, ops: [...left.ops, op], comparators: [...left.comparators, right], span };
      }
      return { type: 'Compare', left, ops: [op], comparators: [right], span };
    }
    return { type: 'BinOp', op, left, right, span };
  }

  private call(node: SyntaxNode): Expr {
    const funcNode = node.firstChild;
    const argList = node.getChild('ArgList');
    if (!funcNode || !argList) return this.unsupported(node, 'Malformed call');
    const args: Expr[] = [];
    const keywords: Keyword[] = [];
    const argKids = kids(argList);
    // f(x for x in xs): a single generator argument.
    if (argKids.some((k) => k.name === 'for')) {
      return { type: 'Call', func: this.expr(funcNode), args: [this.comprehension(argList, 'generator')], keywords: [], span: spanOf(node) };
    }
    for (const group of commaGroups(argKids)) {
      const head = group[0]!;
      if (head.name === '*' && group[1]) {
        args.push({ type: 'Starred', value: this.expr(group[1]), span: { from: head.from, to: group[1].to } });
        continue;
      }
      if (head.name === '**' && group[1]) {
        keywords.push({ name: null, value: this.expr(group[1]), span: { from: head.from, to: group[1].to } });
        continue;
      }
      if (group.length >= 3 && head.name === 'VariableName' && group[1]!.name === 'AssignOp') {
        keywords.push({ name: this.text(head), value: this.expr(group[2]!), span: { from: head.from, to: group[2]!.to } });
      } else if (group.length === 1) {
        args.push(this.expr(head));
      } else {
        return this.unsupported(node, 'Generator arguments are not simulated yet.');
      }
    }
    return { type: 'Call', func: this.expr(funcNode), args, keywords, span: spanOf(node) };
  }

  /** `lower:upper:step`, each part optional. */
  private slice(group: readonly SyntaxNode[]): Expr {
    const parts: Array<Expr | null> = [null];
    for (const k of group) {
      if (k.name === ':') parts.push(null);
      else parts[parts.length - 1] = this.expr(k);
    }
    return { type: 'Slice', lower: parts[0] ?? null, upper: parts[1] ?? null, step: parts[2] ?? null, span: { from: group[0]!.from, to: group[group.length - 1]!.to } };
  }

  private member(node: SyntaxNode): Expr {
    const c = kids(node);
    const valueNode = c[0];
    if (!valueNode) return this.unsupported(node, 'Malformed member expression');
    const span = spanOf(node);
    if (c[1]?.name === '.') {
      const prop = c[2];
      if (!prop) return this.unsupported(node, 'Malformed attribute access');
      return { type: 'Attribute', value: this.expr(valueNode), attr: this.text(prop), span };
    }
    if (c[1]?.name === '[') {
      const inner = c.slice(2, c.length - 1);
      const hasComma = inner.some((k) => k.name === ',');
      const items = commaGroups(inner).map((g): Expr => (g.some((k) => k.name === ':') ? this.slice(g) : g[0]!.name === '*' && g[1] ? { type: 'Starred', value: this.expr(g[1]), span: { from: g[0]!.from, to: g[1].to } } : this.expr(g[0]!)));
      if (items.length === 0) return this.unsupported(node, 'Empty subscript');
      const index: Expr = items.length === 1 && !hasComma ? items[0]! : { type: 'Tuple', elts: items, span: { from: items[0]!.span.from, to: items[items.length - 1]!.span.to } };
      return { type: 'Subscript', value: this.expr(valueNode), index, span };
    }
    return this.unsupported(node, 'Unknown member expression');
  }
}

function isParenthesized(e: Expr): boolean {
  return (e as { parenthesized?: boolean }).parenthesized === true;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v', '\n': '' };

function decodeEscapes(body: string): string | null {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (next in ESCAPES) {
      out += ESCAPES[next];
      i++;
    } else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(body.slice(i + 2, i + 6), 16));
      i += 5;
    } else {
      // Python keeps unknown escapes literally (with a warning).
      out += '\\' + next;
      i++;
    }
  }
  return out;
}

// ---- Position helpers ---------------------------------------------------------

export function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line and 0-based column of an offset. */
export function positionAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo]! };
}
