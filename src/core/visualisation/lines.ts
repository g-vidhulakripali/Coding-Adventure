import { computeLineStarts, parsePythonModule, positionAt, type FunctionDef, type Module, type Span, type Stmt } from '../parser/python/ast';
import { chaptersOf } from './chapters';
import type { Step, Trace } from '../simulation/trace';
import { displayValue, elementDisplay, elementsOf } from '../simulation/values';

/**
 * Line-by-line container view of the code that is running right now.
 *
 * The current function (or file) is a container listing its own source lines.
 * `if`/`elif`/`else`, loops and classes are nested containers. Each line shows
 * where it stands (done / current / not yet / skipped) and, once run, its
 * result as a short number chip. Built from the syntax tree plus the recorded
 * steps — nothing is invented.
 */

export type LineStatus = 'done' | 'current' | 'active' | 'pending' | 'skipped';

export interface LineNode {
  readonly kind: 'stmt' | 'block';
  /** For blocks: what kind of container this is. */
  readonly label?: 'if' | 'if-branch' | 'elif' | 'else' | 'for' | 'while' | 'def' | 'class' | 'with' | 'try' | 'except' | 'finally';
  /** Exact source text (blocks: the header line). */
  readonly code: string;
  readonly line: number;
  readonly endLine: number;
  readonly status: LineStatus;
  /** Result once the line has run, e.g. "= 2.5", "↩ 22.5", "yes", "2/3". */
  readonly chip: string | null;
  readonly children: readonly LineNode[];
}

/** A group of neighbouring lines in a long function. */
export interface LineChapter {
  /** The author's comment above the group, or null. */
  readonly title: string | null;
  readonly startLine: number;
  readonly endLine: number;
  /** The group's nodes: `nodes[first]` to `nodes[last]`. */
  readonly first: number;
  readonly last: number;
  readonly status: 'done' | 'current' | 'pending';
  /** First step of this run inside the group, for jumping there. */
  readonly step: number | null;
}

export interface LineView {
  readonly frame: {
    readonly kind: 'module' | 'function' | 'inputs';
    readonly name: string;
    /** Class that owns this method, if it is one. */
    readonly owner?: string;
    readonly path: string;
    readonly params: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  };
  /** Frames waiting for this one to finish, outermost first, with the line that is waiting. */
  readonly callers: ReadonlyArray<{ readonly name: string; readonly path: string; readonly line: number; readonly code: string }>;
  readonly nodes: readonly LineNode[];
  /** Empty for short code. Every node belongs to exactly one chapter. */
  readonly chapters: readonly LineChapter[];
  /** True when the current step is entering this function (its values are arriving). */
  readonly headerCurrent: boolean;
}

interface Parsed {
  readonly module: Module;
  readonly lineStarts: number[];
  readonly lines: string[];
}

const cache = new WeakMap<ReadonlyMap<string, string>, Map<string, Parsed>>();

function parsed(sources: ReadonlyMap<string, string>, path: string): Parsed | null {
  let byPath = cache.get(sources);
  if (!byPath) cache.set(sources, (byPath = new Map()));
  const hit = byPath.get(path);
  if (hit) return hit;
  const source = sources.get(path);
  if (source === undefined) return null;
  const p = { module: parsePythonModule(source), lineStarts: computeLineStarts(source), lines: source.split('\n') };
  byPath.set(path, p);
  return p;
}

/** Short result text: numbers as they are, lists as their elements, e.g. [10.5 20.0 30.5]. */
const show = (step: Step | undefined) => {
  if (!step?.output) return null;
  const items = elementsOf(step.output);
  if (items) {
    const shown = items.slice(0, 5).map(elementDisplay).join(' ');
    return `[${shown}${items.length > 5 ? ' …' : ''}]`;
  }
  return displayValue(step.output, 18);
};

function findDef(stmts: readonly Stmt[], name: string): FunctionDef | null {
  for (const s of stmts) {
    if (s.type === 'FunctionDef' && s.name === name) return s;
    const inner = findDef(innerBlocks(s), name);
    if (inner) return inner;
  }
  return null;
}

function innerBlocks(s: Stmt): readonly Stmt[] {
  switch (s.type) {
    case 'FunctionDef':
    case 'ClassDef':
    case 'With':
      return s.body;
    case 'If':
      return [...s.branches.flatMap((b) => b.body), ...(s.orelse ?? [])];
    case 'For':
    case 'While':
      return [...s.body, ...s.orelse];
    case 'Try':
      return [...s.body, ...s.handlers.flatMap((h) => h.body), ...s.orelse, ...s.finalbody];
    default:
      return [];
  }
}

/** Finds a definition by its qualified name, so equal method names in different classes are not mixed up. */
function findQualified(stmts: readonly Stmt[], qualname: string): FunctionDef | null {
  const search = (list: readonly Stmt[], part: string): Extract<Stmt, { type: 'FunctionDef' | 'ClassDef' }> | null => {
    for (const s of list) {
      if (s.type === 'FunctionDef' || s.type === 'ClassDef') {
        if (s.name === part) return s;
        continue;
      }
      const inner = search(innerBlocks(s), part);
      if (inner) return inner;
    }
    return null;
  };
  let scope = stmts;
  let found: FunctionDef | null = null;
  for (const part of qualname.split('.').filter((p) => p !== '<locals>')) {
    const hit = search(scope, part);
    if (!hit) return null;
    found = hit.type === 'FunctionDef' ? hit : null;
    scope = hit.body;
  }
  return found;
}

export function buildLineView(trace: Trace, index: number, sources: ReadonlyMap<string, string>): LineView | null {
  const step = trace.steps[index];
  if (!step) return null;
  const frames = step.frames;
  const current = frames[frames.length - 1];
  if (!current) return null;
  const file = parsed(sources, current.path);
  if (!file) return null;

  const lineOf = (offset: number) => positionAt(file.lineStarts, offset).line;
  const range = (span: Span) => ({ line: lineOf(span.from), endLine: lineOf(Math.max(span.from, span.to - 1)) });
  const text = (line: number, endLine = line) =>
    file.lines
      .slice(line - 1, endLine)
      .map((l) => l.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\(\s/g, '(')
      .replace(/\s\)/g, ')');

  // Steps that ran in THIS call of the function (frame ids are unique per call).
  const mine = trace.steps.slice(0, index + 1).filter((s) => s.frameId === current.id);
  const now = step.frameId === current.id ? step : null;
  const inRange = (s: Step, line: number, endLine: number) => s.span.path === current.path && s.span.startLine >= line && s.span.startLine <= endLine;
  const last = (line: number, endLine: number, kinds?: readonly Step['kind'][]) =>
    [...mine].reverse().find((s) => inRange(s, line, endLine) && (!kinds || kinds.includes(s.kind)));

  const statusFor = (line: number, endLine: number, hasCurrentChild: boolean): LineStatus => {
    if (now && inRange(now, line, endLine)) return hasCurrentChild ? 'active' : 'current';
    return mine.some((s) => s.id < index && inRange(s, line, endLine)) ? 'done' : 'pending';
  };

  const stmtChip = (line: number, endLine: number): string | null => {
    const s = last(line, endLine, ['assign', 'return', 'print', 'error', 'unknown', 'unsupported']);
    if (!s) {
      const any = last(line, endLine);
      return any && any.kind !== 'define' && any.kind !== 'import' && any.kind !== 'call' && any.kind !== 'enter' ? show(any) : null;
    }
    switch (s.kind) {
      case 'assign':
        return show(s) ? `= ${show(s)}` : null;
      case 'return':
        return `↩ ${show(s) ?? 'None'}`;
      case 'print':
        return `🖥 ${s.inputs.map((i) => (i.value.t === 'str' ? i.value.v : displayValue(i.value, 14))).join(' ')}`;
      case 'error':
        return '✗';
      case 'unknown':
        return '= ?';
      default:
        return '🚧';
    }
  };

  const convert = (stmts: readonly Stmt[], forcedSkip: boolean): LineNode[] =>
    stmts.flatMap((s): LineNode[] => {
      if (s.type === 'Expr' && s.isDocstring) return [];
      if (s.type === 'FunctionDef') {
        const r = range(s.headerSpan);
        return [{ kind: 'block', label: 'def', code: text(r.line, r.endLine).replace(/:$/, ''), ...r, status: forcedSkip ? 'skipped' : statusFor(r.line, r.endLine, false), chip: null, children: [] }];
      }
      if (s.type === 'ClassDef') {
        // A class is one big container; its methods are listed inside it (each opens when called).
        const r = range(s.headerSpan);
        const methods = s.body
          .filter((m): m is FunctionDef => m.type === 'FunctionDef')
          .map((m): LineNode => {
            const mr = range(m.headerSpan);
            return { kind: 'block', label: 'def', code: text(mr.line, mr.endLine).replace(/:$/, ''), ...mr, status: 'pending', chip: null, children: [] };
          });
        return [{ kind: 'block', label: 'class', code: text(r.line).replace(/:$/, ''), ...r, status: forcedSkip ? 'skipped' : statusFor(r.line, r.endLine, false), chip: null, children: methods }];
      }
      if (s.type === 'If') {
        const branches: LineNode[] = [];
        let anyTaken = false;
        s.branches.forEach((b, i) => {
          const r = range(b.span);
          const decision = last(r.line, r.endLine, ['decision']);
          const taken = decision?.target?.kind === 'branch' ? decision.target.taken : null;
          if (taken) anyTaken = true;
          const skipped = forcedSkip || taken === false || (taken === null && anyTaken);
          const children = convert(b.body, skipped || taken !== true);
          const childCurrent = children.some((c) => c.status === 'current' || c.status === 'active');
          const bodyEnd = b.body.length ? range(b.body[b.body.length - 1]!.span).endLine : r.endLine;
          const own = statusFor(r.line, r.endLine, false);
          branches.push({
            kind: 'block',
            label: i === 0 ? 'if-branch' : 'elif',
            code: text(r.line, r.endLine).replace(/:$/, ''),
            line: r.line,
            endLine: bodyEnd,
            status: own === 'current' ? 'current' : skipped ? 'skipped' : childCurrent ? 'active' : own,
            chip: taken === null ? null : `${taken ? 'yes' : 'no'}${decision?.assumption ? '?' : ''}`,
            children: taken === true ? children : children.map((c) => ({ ...c, status: c.status === 'current' ? c.status : skippedStatus(c, taken === false || anyTaken) })),
          });
        });
        if (s.orelse && s.elseSpan) {
          const r = range(s.elseSpan);
          const decision = last(r.line, r.line, ['decision']);
          const taken = decision ? true : null;
          const skipped = forcedSkip || (taken === null && anyTaken);
          const children = convert(s.orelse, skipped || taken !== true);
          const childCurrent = children.some((c) => c.status === 'current' || c.status === 'active');
          branches.push({
            kind: 'block',
            label: 'else',
            code: 'else',
            line: r.line,
            endLine: s.orelse.length ? range(s.orelse[s.orelse.length - 1]!.span).endLine : r.line,
            status: skipped ? 'skipped' : childCurrent ? 'active' : statusFor(r.line, r.line, false),
            chip: taken ? 'yes' : anyTaken ? 'no' : null,
            children: taken ? children : children.map((c) => ({ ...c, status: skippedStatus(c, anyTaken) })),
          });
        }
        const r = range(s.span);
        const active = branches.some((b) => b.status === 'active' || b.status === 'current');
        const started = branches.some((b) => b.chip !== null);
        return [{ kind: 'block', label: 'if', code: 'if', ...r, status: forcedSkip ? 'skipped' : active ? 'active' : started ? 'done' : 'pending', chip: null, children: branches }];
      }
      if (s.type === 'For' || s.type === 'While') {
        const header = range(s.headerSpan);
        const whole = range(s.span);
        const children = convert(s.body, forcedSkip);
        const childCurrent = children.some((c) => c.status === 'current' || c.status === 'active');
        const loopStep = last(header.line, header.line, ['loop', 'decision']);
        const iter = loopStep ? /Iteration (\d+) of (\d+)/.exec(loopStep.title) : null;
        const chip = loopStep?.title === 'One example item' ? '1/?' : iter ? `${iter[1]}/${iter[2]}` : loopStep?.title === 'Loop finished' ? '✓' : null;
        return [
          {
            kind: 'block',
            label: s.type === 'For' ? 'for' : 'while',
            code: text(header.line).replace(/:$/, ''),
            line: header.line,
            endLine: whole.endLine,
            status: forcedSkip ? 'skipped' : childCurrent ? 'active' : statusFor(header.line, header.line, false),
            chip,
            children,
          },
        ];
      }
      if (s.type === 'With' || s.type === 'Try') {
        const container = (label: LineNode['label'], code: string, line: number, body: readonly Stmt[], skip: boolean, own: LineStatus): LineNode => {
          const children = convert(body, skip);
          const inside = children.some((c) => c.status === 'current' || c.status === 'active');
          const endLine = body.length ? range(body[body.length - 1]!.span).endLine : line;
          const ran = children.some((c) => c.status === 'done');
          return { kind: 'block', label, code, line, endLine, status: skip ? 'skipped' : own === 'current' ? 'current' : inside ? 'active' : own === 'pending' && ran ? 'done' : own, chip: null, children };
        };
        const head = range(s.headerSpan);
        if (s.type === 'With') return [container('with', text(head.line, head.endLine).replace(/:$/, ''), head.line, s.body, forcedSkip, statusFor(head.line, head.endLine, false))];
        const parts = [container('try', 'try', head.line, s.body, forcedSkip, 'pending')];
        const bodyDone = s.body.length > 0 && s.body.every((b) => last(range(b.span).line, range(b.span).endLine));
        for (const h of s.handlers) {
          const r = range(h.span);
          const caught = last(r.line, r.line, ['decision']) !== undefined;
          parts.push(container('except', text(r.line).replace(/:$/, ''), r.line, h.body, forcedSkip || (!caught && bodyDone), statusFor(r.line, r.line, false)));
        }
        if (s.elseSpan) parts.push(container('else', 'else', range(s.elseSpan).line, s.orelse, forcedSkip, 'pending'));
        if (s.finallySpan) parts.push(container('finally', 'finally', range(s.finallySpan).line, s.finalbody, forcedSkip, 'pending'));
        return parts;
      }
      const r = range(s.span);
      return [{ kind: 'stmt', code: text(r.line, r.endLine), ...r, status: forcedSkip ? 'skipped' : statusFor(r.line, r.endLine, false), chip: forcedSkip ? null : stmtChip(r.line, r.endLine), children: [] }];
    });

  let frameInfo: LineView['frame'];
  let nodes: LineNode[];
  if (current.name === '<simulation>') {
    frameInfo = { kind: 'inputs', name: 'your inputs', path: current.path, params: [] };
    nodes = [];
  } else if (current.kind === 'module') {
    frameInfo = { kind: 'module', name: current.path.split('/').pop() ?? current.path, path: current.path, params: [] };
    nodes = convert(file.module.body, false);
  } else {
    const name = current.name.split('.').pop() ?? current.name;
    const def = findQualified(file.module.body, current.name) ?? findDef(file.module.body, name);
    const params = def
      ? def.params.map((p) => {
          const v = current.vars.find((x) => x.name === p.name);
          return { name: p.name, value: v ? displayValue(v.value, 14) : '?' };
        })
      : [];
    const parts = current.name.split('.');
    const owner = parts.length > 1 && !current.name.includes('<locals>') ? parts[parts.length - 2] : undefined;
    frameInfo = { kind: 'function', name, path: current.path, params, ...(owner ? { owner } : {}) };
    nodes = def ? convert(def.body, false) : [];
  }

  const callers = frames.slice(0, -1).flatMap((f) => {
    if (f.name === '<simulation>') return [];
    const waiting = [...trace.steps.slice(0, index + 1)].reverse().find((s) => s.frameId === f.id);
    if (!waiting) return [];
    const p = parsed(sources, f.path);
    const code = p ? p.lines.slice(waiting.span.startLine - 1, waiting.span.endLine).map((l) => l.trim()).join(' ').replace(/\s+/g, ' ') : waiting.code;
    return [{ name: f.kind === 'module' ? f.path : `${f.name.split('.').pop()}()`, path: f.path, line: waiting.span.startLine, code }];
  });

  const inChapter = (s: Step, from: number, to: number) => s.frameId === current.id && s.span.path === current.path && s.span.startLine >= from && s.span.startLine <= to;
  const chapters = chaptersOf(nodes, file.lines).map((c): LineChapter => {
    const has = nodes.slice(c.first, c.last + 1);
    const step = trace.steps.find((s) => inChapter(s, c.startLine, c.endLine));
    return {
      title: c.title,
      startLine: c.startLine,
      endLine: c.endLine,
      first: c.first,
      last: c.last,
      status: has.some((n) => n.status === 'current' || n.status === 'active') ? 'current' : has.some((n) => n.status === 'done') ? 'done' : 'pending',
      step: step?.id ?? null,
    };
  });

  return { frame: frameInfo, callers, nodes, chapters, headerCurrent: now?.kind === 'enter' || (frameInfo.kind === 'inputs' && now !== null) };
}

function skippedStatus(node: LineNode, skipped: boolean): LineStatus {
  return skipped ? 'skipped' : node.status === 'done' ? 'done' : 'pending';
}
