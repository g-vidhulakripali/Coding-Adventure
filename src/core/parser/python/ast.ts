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
  | { readonly type: 'List' | 'Tuple'; readonly elts: readonly Expr[]; readonly span: Span }
  | { readonly type: 'Dict'; readonly keys: readonly Expr[]; readonly values: readonly Expr[]; readonly span: Span }
  | { readonly type: 'BinOp'; readonly op: string; readonly left: Expr; readonly right: Expr; readonly span: Span }
  | { readonly type: 'BoolOp'; readonly op: 'and' | 'or'; readonly left: Expr; readonly right: Expr; readonly span: Span }
  | { readonly type: 'Compare'; readonly left: Expr; readonly ops: readonly string[]; readonly comparators: readonly Expr[]; readonly span: Span }
  | { readonly type: 'UnaryOp'; readonly op: '-' | '+' | 'not' | '~'; readonly operand: Expr; readonly span: Span }
  | { readonly type: 'Call'; readonly func: Expr; readonly args: readonly Expr[]; readonly keywords: readonly Keyword[]; readonly span: Span }
  | { readonly type: 'Attribute'; readonly value: Expr; readonly attr: string; readonly span: Span }
  | { readonly type: 'Subscript'; readonly value: Expr; readonly index: Expr; readonly span: Span }
  | { readonly type: 'IfExp'; readonly test: Expr; readonly body: Expr; readonly orelse: Expr; readonly span: Span }
  | UnsupportedNode;

export interface Keyword {
  readonly name: string;
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
  | { readonly type: 'For'; readonly target: Expr; readonly iter: Expr; readonly body: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | { readonly type: 'While'; readonly test: Expr; readonly body: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | FunctionDef
  | { readonly type: 'ClassDef'; readonly name: string; readonly bases: readonly Expr[]; readonly body: readonly Stmt[]; readonly headerSpan: Span; readonly span: Span }
  | { readonly type: 'Import'; readonly names: readonly ImportName[]; readonly span: Span }
  | { readonly type: 'ImportFrom'; readonly module: string | null; readonly level: number; readonly names: readonly ImportName[]; readonly span: Span }
  | { readonly type: 'Pass' | 'Break' | 'Continue'; readonly span: Span }
  | UnsupportedNode;

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

export function parsePythonModule(source: string): Module {
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
        if (value.length > 1) return { type: 'Return', value: this.tupleFrom(node, value), span };
        return { type: 'Return', value: value[0] ? this.expr(value[0]) : null, span };
      }
      case 'IfStatement':
        return this.ifStmt(node);
      case 'ForStatement': {
        const c = kids(node);
        const inIdx = c.findIndex((k) => k.name === 'in');
        const body = c.find((k) => k.name === 'Body') ?? null;
        if (c.filter((k) => k.name === 'Body').length > 1) return this.unsupported(node, '`for … else` is not supported yet.');
        const targets = c.slice(1, inIdx).filter((k) => k.name !== ',');
        const iterNode = c.slice(inIdx + 1).find((k) => k.name !== 'Body');
        if (inIdx < 0 || !iterNode || targets.length === 0) return this.unsupported(node, 'Malformed for loop');
        const target = targets.length === 1 ? this.expr(targets[0]!) : this.tupleFrom(node, targets);
        return {
          type: 'For',
          target,
          iter: this.expr(iterNode),
          body: this.body(body),
          headerSpan: { from: node.from, to: body ? body.from + 1 : node.to },
          span,
        };
      }
      case 'WhileStatement': {
        const c = kids(node);
        if (c.filter((k) => k.name === 'Body').length > 1) return this.unsupported(node, '`while … else` is not supported yet.');
        const test = c[1];
        const body = c.find((k) => k.name === 'Body') ?? null;
        if (!test) return this.unsupported(node, 'Malformed while loop');
        return { type: 'While', test: this.expr(test), body: this.body(body), headerSpan: { from: node.from, to: body ? body.from + 1 : node.to }, span };
      }
      case 'FunctionDefinition':
        return this.functionDef(node, [], node);
      case 'ClassDefinition':
        return this.classDef(node, [], node);
      case 'DecoratedStatement': {
        const decorators = kids(node)
          .filter((c) => c.name === 'Decorator')
          .map((d) => {
            const e = kids(d).find((k) => k.name !== 'At');
            return e ? this.expr(e) : this.unsupported(d, 'Empty decorator');
          });
        const fn = node.getChild('FunctionDefinition');
        if (fn) return this.functionDef(fn, decorators, node);
        const cls = node.getChild('ClassDefinition');
        if (cls) return this.classDef(cls, decorators, node);
        return this.unsupported(node, 'Unknown decorated statement');
      }
      case 'ImportStatement':
        return this.importStmt(node);
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
      return this.unsupported(node, 'Annotation without a value is not simulated.');
    }
    const segments: SyntaxNode[][] = [[]];
    for (const k of c) {
      if (k.name === 'AssignOp') segments.push([]);
      else if (k.name !== 'TypeDef') segments[segments.length - 1]!.push(k);
    }
    const exprs = segments.map((seg) => {
      const parts = seg.filter((s) => s.name !== ',');
      const trailingComma = seg.length > 0 && seg[seg.length - 1]!.name === ',';
      if (parts.length === 1 && !trailingComma) return this.expr(parts[0]!);
      return this.tupleFrom(node, parts);
    });
    const value = exprs.pop();
    if (!value || exprs.length === 0) return this.unsupported(node, 'Malformed assignment');
    return { type: 'Assign', targets: exprs, value, span: spanOf(node) };
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
        if (!n) return this.unsupported(node, 'Malformed parameter');
        params.push({ name: this.text(n), kind: head.name === '*' ? 'varargs' : 'varkw', defaultValue: null, span: { from: head.from, to: n.to } });
        if (head.name === '*') kind = 'kwonly';
        continue;
      }
      if (head.name === '/') continue; // positional-only marker: no effect on our binding model
      if (head.name !== 'VariableName') return this.unsupported(node, `Unsupported parameter form \`${this.text(head)}\``);
      const eq = group.findIndex((g) => g.name === 'AssignOp');
      const defaultNode = eq >= 0 ? group[eq + 1] : undefined;
      params.push({
        name: this.text(head),
        kind,
        defaultValue: defaultNode ? this.expr(defaultNode) : null,
        span: { from: head.from, to: group[group.length - 1]!.to },
      });
    }
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

  private classDef(node: SyntaxNode, decorators: Expr[], outer: SyntaxNode): Stmt {
    const name = node.getChild('VariableName');
    const args = node.getChild('ArgList');
    const body = node.getChild('Body');
    if (!name) return this.unsupported(node, 'Malformed class definition');
    void decorators;
    return {
      type: 'ClassDef',
      name: this.text(name),
      bases: args ? commaGroups(kids(args)).map((g) => this.expr(g[0]!)) : [],
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
        let value = '';
        for (const part of kids(node)) {
          const s = this.string(part);
          if (s.type !== 'Constant') return s;
          value += String(s.value);
        }
        return { type: 'Constant', kind: 'str', value, span };
      }
      case 'Boolean':
        return { type: 'Constant', kind: 'bool', value: this.text(node) === 'True', span };
      case 'None':
        return { type: 'Constant', kind: 'none', value: null, span };
      case 'ArrayExpression':
        return { type: 'List', elts: kids(node).filter((k) => !SKIP.has(k.name)).map((k) => this.expr(k)), span };
      case 'TupleExpression':
        return { type: 'Tuple', elts: kids(node).filter((k) => !SKIP.has(k.name)).map((k) => this.expr(k)), span };
      case 'ParenthesizedExpression': {
        const inner = kids(node).find((k) => !SKIP.has(k.name));
        if (!inner) return this.unsupported(node, 'Empty parentheses');
        // Keep the inner node but widen its span to include the parentheses.
        return Object.assign({}, this.expr(inner), { span, parenthesized: true }) as Expr;
      }
      case 'DictionaryExpression': {
        const keys: Expr[] = [];
        const values: Expr[] = [];
        for (const group of commaGroups(kids(node))) {
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
        const op = this.text(opNode) as '-' | '+' | 'not' | '~';
        const operand = this.expr(operandNode);
        if (op === 'not' && operand.type === 'BoolOp' && !isParenthesized(operand)) {
          // Lezer groups `not a or b` as `not (a or b)`; Python means `(not a) or b`.
          return this.unsupported(node, 'Ambiguous `not … and/or …` grouping: the current parser cannot read this precedence correctly. Add parentheses to simulate it.');
        }
        return { type: 'UnaryOp', op, operand, span };
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
      case 'LambdaExpression':
        return this.unsupported(node, 'Lambda expressions are not simulated yet.');
      case 'FormatString':
        return this.unsupported(node, 'f-strings are not simulated yet.');
      case 'ArrayComprehensionExpression':
      case 'DictionaryComprehensionExpression':
      case 'SetComprehensionExpression':
      case 'ComprehensionExpression':
        return this.unsupported(node, 'Comprehensions are not simulated yet.');
      case 'AwaitExpression':
        return this.unsupported(node, '`await` is not simulated.');
      default:
        return this.unsupported(node, `\`${node.name}\` expressions are not supported yet.`);
    }
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
    const left = this.expr(leftNode);
    const right = this.expr(rightNode);
    const span = spanOf(node);
    if (op === 'and' || op === 'or') return { type: 'BoolOp', op, left, right, span };
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
    for (const group of commaGroups(kids(argList))) {
      const head = group[0]!;
      if (head.name === '*' || head.name === '**') return this.unsupported(node, 'Star-arguments (`*args`, `**kwargs`) are not simulated yet.');
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
      if (inner.some((k) => k.name === ':')) return this.unsupported(node, 'Slicing (`a[i:j]`) is not simulated yet.');
      const parts = inner.filter((k) => k.name !== ',');
      if (parts.length === 0) return this.unsupported(node, 'Empty subscript');
      const index = parts.length === 1 && !inner.some((k) => k.name === ',') ? this.expr(parts[0]!) : this.tupleFrom(node, parts);
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
