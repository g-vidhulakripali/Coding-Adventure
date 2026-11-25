import { computeLineStarts, positionAt, type Expr, type Module, type Stmt } from '../../parser/python/ast';

/**
 * What a file consists of and what is not understood in it. Every statement is
 * counted; nothing is left out silently.
 */

export interface Gap {
  readonly line: number;
  readonly code: string;
  readonly reason: string;
  /** `unread`: the parser adapter has no shape for it. `not-run`: read and shown, but the simulation gives `?`. */
  readonly kind: 'unread' | 'not-run';
}

export interface Coverage {
  readonly statements: number;
  /** Statements without any unread part. */
  readonly understood: number;
  readonly syntaxErrors: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly gaps: readonly Gap[];
}

const MAX_GAPS = 200;

export function coverageOf(module: Module): Coverage {
  const lineStarts = computeLineStarts(module.source);
  const counts: Record<string, number> = {};
  const gaps: Gap[] = [];
  let statements = 0;
  let understood = 0;
  const count = (name: string, n = 1) => {
    counts[name] = (counts[name] ?? 0) + n;
  };
  const gap = (node: { span: { from: number; to: number } }, reason: string, kind: Gap['kind']) => {
    if (gaps.length >= MAX_GAPS) return;
    const code = module.source.slice(node.span.from, node.span.to).replace(/\s+/g, ' ');
    gaps.push({ line: positionAt(lineStarts, node.span.from).line, code: code.length > 80 ? `${code.slice(0, 79)}…` : code, reason, kind });
  };

  /** Returns false when something inside the expression could not be read. */
  const expr = (n: unknown): boolean => {
    if (!n || typeof n !== 'object') return true;
    if (Array.isArray(n)) return n.map(expr).every(Boolean);
    const e = n as Expr;
    let ok = true;
    switch (e.type) {
      case 'Unsupported':
        gap(e, e.reason, 'unread');
        return false;
      case 'Call':
        count('calls');
        break;
      case 'Comprehension':
        count('comprehensions');
        break;
      case 'Lambda':
        count('lambdas');
        break;
      case 'Await':
        count('awaits');
        gap(e, '`await` is not simulated.', 'not-run');
        break;
      case 'Yield':
        count('yields');
        break;
    }
    for (const [k, x] of Object.entries(e)) if (k !== 'span' && typeof x === 'object') ok = expr(x) && ok;
    return ok;
  };

  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (s.type === 'Expr' && s.isDocstring) continue;
      statements++;
      let ok = true;
      switch (s.type) {
        case 'Unsupported':
          gap(s, s.reason, 'unread');
          ok = false;
          break;
        case 'FunctionDef':
          count(s.isAsync ? 'async functions' : 'functions');
          if (s.isAsync) gap({ span: s.headerSpan }, 'Async functions are read but not simulated.', 'not-run');
          if (s.decorators.length) count('decorators', s.decorators.length);
          ok = expr(s.params);
          visit(s.body);
          break;
        case 'ClassDef':
          count('classes');
          if (s.decorators.length) count('decorators', s.decorators.length);
          ok = expr(s.bases);
          visit(s.body);
          break;
        case 'If':
          count('conditions', s.branches.length);
          for (const b of s.branches) {
            ok = expr(b.test) && ok;
            visit(b.body);
          }
          if (s.orelse) visit(s.orelse);
          break;
        case 'For':
        case 'While':
          count('loops');
          ok = s.type === 'For' ? expr(s.target) && expr(s.iter) : expr(s.test);
          visit(s.body);
          visit(s.orelse);
          break;
        case 'With':
          count('with blocks');
          for (const i of s.items) ok = expr(i.context) && expr(i.target) && ok;
          visit(s.body);
          break;
        case 'Try':
          count('exceptions', s.handlers.length);
          visit(s.body);
          for (const h of s.handlers) {
            ok = expr(h.exc) && ok;
            visit(h.body);
          }
          visit(s.orelse);
          visit(s.finalbody);
          break;
        case 'Import':
        case 'ImportFrom':
          count('imports', s.names.length || 1);
          break;
        case 'Assign':
        case 'AugAssign':
          count('assignments');
          ok = expr(s);
          break;
        case 'Return':
          count('returns');
          ok = expr(s);
          break;
        case 'Raise':
          count('raises');
          ok = expr(s);
          break;
        default:
          ok = expr(s);
      }
      if (ok) understood++;
    }
  };
  visit(module.body);
  return { statements, understood, syntaxErrors: module.syntaxErrors.length, counts, gaps };
}
