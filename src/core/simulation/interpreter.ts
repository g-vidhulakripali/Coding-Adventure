import { computeLineStarts, parsePythonModule, positionAt, type Expr, type FunctionDef, type Module, type Span, type Stmt } from '../parser/python/ast';
import type { SourceSpan } from '../source-mapping/types';
import { csvToDataFrame, normalisePath } from './csv';
import { MissingDataError, PyError, UnsupportedError } from './errors';
import { callLibraryFunction, callMethod, MODELLED_LIBRARIES, moduleAttribute, objectAttribute, subscript } from './libraries';
import { binaryOp, compareOp, iterate, rangeLength, truthy, unaryOp } from './operators';
import type { FrameSnapshot, Step, StepInput, StepKind, StepTarget, Trace, VisualRole } from './trace';
import {
  displayValue,
  floatRepr,
  isApproximatePrint,
  NONE,
  numericOf,
  pyStrOf,
  typeLabel,
  typeName,
  type FunctionValue,
  type PyValue,
} from './values';

/**
 * Controlled, deterministic simulation of a supported Python subset.
 *
 * Python code is NEVER executed. This walks the parsed syntax tree and models
 * each operation in JavaScript, recording one step per meaningful operation
 * with its exact source span, inputs, output and destination. Anything outside
 * the model stops the run with an explicit "unsupported" step.
 */

export interface SimulationProgram {
  /** Repository-relative path → original source, for every Python file in the project. */
  readonly sources: ReadonlyMap<string, string>;
  /** Repository-relative path → text of data files the code may read (CSV). */
  readonly dataFiles?: ReadonlyMap<string, string>;
}

export type SimulationEntry =
  | { readonly kind: 'script'; readonly path: string }
  | { readonly kind: 'function'; readonly path: string; readonly name: string; readonly args: ReadonlyMap<string, PyValue> }
  | {
      readonly kind: 'method';
      readonly path: string;
      readonly className: string;
      readonly method: string;
      /** Arguments used to make the object (its `__init__`). */
      readonly initArgs: ReadonlyMap<string, PyValue>;
      /** Arguments of the method itself. */
      readonly args: ReadonlyMap<string, PyValue>;
    };

export interface SimulationOptions {
  /** Replacement values for literal expressions, keyed by `overrideKey`. */
  readonly overrides?: ReadonlyMap<string, PyValue>;
  readonly maxSteps?: number;
  readonly maxDepth?: number;
  readonly maxIterations?: number;
}

export function overrideKey(path: string, span: Span): string {
  return `${path}:${span.from}:${span.to}`;
}

const BUILTINS = new Set(['print', 'sum', 'len', 'float', 'int', 'str', 'bool', 'abs', 'round', 'min', 'max', 'range', 'list', 'tuple', 'sorted']);
/** Built-ins that exist in Python but are not modelled; reported as unsupported rather than NameError. */
const KNOWN_UNMODELLED_BUILTINS = new Set(['open', 'input', 'isinstance', 'type', 'enumerate', 'zip', 'map', 'filter', 'dict', 'set', 'any', 'all', 'getattr', 'setattr', 'hasattr', 'reversed', 'iter', 'next', 'repr', 'hash', 'id', 'vars', 'dir', 'eval', 'exec', 'super', 'object', 'Exception', 'ValueError', 'TypeError']);

interface Binding {
  value: PyValue;
  setAt: number | null;
}

interface ModuleState {
  readonly path: string;
  readonly name: string;
  readonly ast: Module;
  readonly lineStarts: number[];
  readonly globals: Map<string, Binding>;
  status: 'new' | 'loading' | 'loaded';
}

type Member =
  | { readonly kind: 'method' | 'property' | 'static' | 'async'; readonly fn: FunctionValue }
  | { readonly kind: 'attr'; readonly value: PyValue }
  | { readonly kind: 'unsupported'; readonly reason: string };

interface ClassState {
  readonly name: string;
  readonly path: string;
  readonly headerSpan: Span;
  readonly bases: readonly ClassState[];
  readonly members: Map<string, Member>;
}

interface ObjectState {
  readonly cls: ClassState;
  readonly fields: Map<string, Binding>;
}

interface Frame {
  readonly id: number;
  readonly name: string;
  readonly kind: 'module' | 'function';
  readonly locals: Map<string, Binding>;
  readonly module: ModuleState;
}

interface Ev {
  readonly value: PyValue;
  readonly step: number | null;
  readonly variable: string | null;
}

class ReturnSignal {
  constructor(
    readonly value: PyValue,
    readonly step: number,
  ) {}
}
class BreakSignal {}
class ContinueSignal {}
class StopSignal {
  constructor(
    readonly kind: 'unsupported' | 'error' | 'limit',
    readonly message: string,
  ) {}
}

interface StepFields {
  readonly kind: StepKind;
  readonly role: VisualRole;
  readonly title: string;
  readonly inputs?: StepInput[];
  readonly output?: PyValue | null;
  readonly target?: StepTarget | null;
  readonly selectedIndex?: number | null;
  readonly what: string;
  readonly why: string;
  readonly notes?: string[];
  readonly evidence?: 'simulated' | 'unsupported';
}

const v = (value: PyValue) => `\`${displayValue(value, 40)}\``;

export function simulate(program: SimulationProgram, entry: SimulationEntry, options: SimulationOptions = {}): Trace {
  return new Interpreter(program, entry, options).run();
}

class Interpreter {
  private readonly steps: Step[] = [];
  private readonly console: string[] = [];
  private readonly assumptions: string[] = [];
  private readonly skipped: Array<{ reason: string; span: SourceSpan }> = [];
  private readonly modules = new Map<string, ModuleState>();
  private readonly frames: Frame[] = [];
  private readonly calls: Array<{ callStep: number | null; callerFrameId: number }> = [];
  private nextFrameId = 0;
  private readonly classes = new Map<string, ClassState>();
  private readonly heap = new Map<number, ObjectState>();
  private nextObjectId = 1;
  private readCsvAssumption = false;
  private readonly overrides: ReadonlyMap<string, PyValue>;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  private readonly maxIterations: number;

  constructor(
    private readonly program: SimulationProgram,
    private readonly entry: SimulationEntry,
    options: SimulationOptions,
  ) {
    this.overrides = options.overrides ?? new Map();
    this.maxSteps = options.maxSteps ?? 2000;
    this.maxDepth = options.maxDepth ?? 40;
    this.maxIterations = options.maxIterations ?? 500;
  }

  run(): Trace {
    let stop: Trace['stop'] = null;
    const entryLabel =
      this.entry.kind === 'script'
        ? `Run ${this.entry.path} as a script`
        : this.entry.kind === 'method'
          ? `Use ${this.entry.className}.${this.entry.method}() from ${this.entry.path}`
          : `Call ${this.entry.name}() from ${this.entry.path}`;
    try {
      const mod = this.moduleFor(this.entry.path);
      if (!mod) throw new UnsupportedError(`${this.entry.path} is not a Python file in this project.`);
      if (this.entry.kind === 'script') {
        this.assumptions.push(`${this.entry.path} runs as the main script, so \`__name__ == "__main__"\`.`);
        this.execModule(mod, true);
      } else if (this.entry.kind === 'method') {
        this.execModule(mod, false);
        this.callEntryMethod(mod, this.entry);
      } else {
        this.execModule(mod, false);
        this.callEntryFunction(mod, this.entry.name, this.entry.args);
      }
    } catch (err) {
      stop = this.handleStop(err);
    }

    // Link each producing step to the first later step that consumes it.
    for (const step of this.steps) {
      for (const input of step.inputs) {
        if (input.fromStep !== null) {
          const source = this.steps[input.fromStep];
          if (source && source.usedBy === null && source.id < step.id) source.usedBy = step.id;
        }
      }
    }

    return {
      entryLabel,
      steps: this.steps,
      console: this.console,
      status: stop ? 'stopped' : 'completed',
      stop,
      assumptions: this.assumptions,
      skipped: this.skipped,
    };
  }

  /** Records the error/unsupported step for `err` once, at `span` in `mod`. */
  private recordFailure(err: PyError | UnsupportedError, mod: ModuleState, span: Span) {
    if (err.recorded) return;
    err.recorded = true;
    if (err instanceof PyError) {
      const message = `${err.pyType}: ${err.message}`;
      this.recordAt(mod, span, {
        kind: 'error',
        role: 'decision',
        title: err.pyType,
        what: `The simulated operation raises ${message}`,
        why: 'Python would stop here with this exception (exception handling is not simulated yet).',
      });
    } else {
      this.recordAt(mod, span, {
        kind: 'unsupported',
        role: 'value',
        title: 'Not simulated',
        what: err.message,
        why: 'The simulation only models a subset of Python. Rather than guess, it stops here. The source and static information remain available.',
        evidence: 'unsupported',
      });
    }
  }

  private handleStop(err: unknown): Trace['stop'] {
    const frame = this.frames[this.frames.length - 1];
    const mod = frame?.module ?? this.moduleFor(this.entry.path);
    if (err instanceof StopSignal) return { kind: err.kind, message: err.message };
    if (err instanceof MissingDataError) {
      if (mod) this.recordFailure(err, mod, err.span ?? this.lastSpan(mod));
      return { kind: 'missing-data', message: err.message, path: err.missingPath };
    }
    if (err instanceof PyError || err instanceof UnsupportedError) {
      if (mod) this.recordFailure(err, mod, err.span ?? this.lastSpan(mod));
      return err instanceof PyError ? { kind: 'error', message: `${err.pyType}: ${err.message}` } : { kind: 'unsupported', message: err.message };
    }
    if (err instanceof ReturnSignal) return { kind: 'error', message: "SyntaxError: 'return' outside function" };
    return { kind: 'error', message: `Internal simulation error: ${err instanceof Error ? err.message : String(err)}` };
  }

  private lastSpan(mod: ModuleState): Span {
    const last = this.steps[this.steps.length - 1];
    if (last && last.span.path === mod.path) {
      return { from: this.offsetOf(mod, last.span.startLine, last.span.startColumn ?? 0), to: this.offsetOf(mod, last.span.endLine, last.span.endColumn ?? 0) };
    }
    return { from: 0, to: Math.min(mod.ast.source.length, mod.ast.source.indexOf('\n') >= 0 ? mod.ast.source.indexOf('\n') : mod.ast.source.length) };
  }

  private offsetOf(mod: ModuleState, line: number, column: number): number {
    return (mod.lineStarts[line - 1] ?? 0) + column;
  }

  // ---- Modules -------------------------------------------------------------

  private moduleFor(path: string): ModuleState | null {
    const existing = this.modules.get(path);
    if (existing) return existing;
    const source = this.program.sources.get(path);
    if (source === undefined) return null;
    const ast = parsePythonModule(source);
    const state: ModuleState = {
      path,
      name: moduleNameOf(path),
      ast,
      lineStarts: computeLineStarts(source),
      globals: new Map(),
      status: 'new',
    };
    this.modules.set(path, state);
    return state;
  }

  private execModule(mod: ModuleState, asMain: boolean): void {
    if (mod.status !== 'new') return;
    mod.status = 'loading';
    mod.globals.set('__name__', { value: { t: 'str', v: asMain ? '__main__' : mod.name }, setAt: null });
    this.pushFrame({ name: '<module>', kind: 'module', locals: mod.globals, module: mod });
    try {
      this.execBlock(mod.ast.body, mod);
    } finally {
      this.frames.pop();
    }
    mod.status = 'loaded';
  }

  private resolveModule(name: string | null, level: number, fromPath: string): string | null {
    const parts = name ? name.split('.') : [];
    const bases: string[] = [];
    if (level > 0) {
      let dir = dirname(fromPath);
      for (let i = 1; i < level; i++) dir = dirname(dir);
      bases.push(dir);
    } else {
      bases.push(dirname(this.entry.path), '');
    }
    for (const base of [...new Set(bases)]) {
      const prefix = [base, ...parts].filter(Boolean).join('/');
      const candidates = parts.length ? [`${prefix}.py`, `${prefix}/__init__.py`] : [`${prefix ? prefix + '/' : ''}__init__.py`];
      for (const c of candidates) if (this.program.sources.has(c)) return c;
    }
    return null;
  }

  // ---- Frames & recording ------------------------------------------------------

  private get frame(): Frame {
    return this.frames[this.frames.length - 1]!;
  }

  private pushFrame(f: Omit<Frame, 'id'>): Frame {
    if (this.frames.length >= this.maxDepth) throw new StopSignal('limit', `Stopped at call depth ${this.maxDepth} (possible runaway recursion).`);
    const frame = { ...f, id: this.nextFrameId++ };
    this.frames.push(frame);
    return frame;
  }

  private snapshot(): FrameSnapshot[] {
    return this.frames.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.module.path,
      kind: f.kind,
      vars: [...f.locals.entries()].filter(([name]) => !name.startsWith('__')).map(([name, b]) => ({ name, value: this.resolve(b.value), setAt: b.setAt })),
    }));
  }

  /** Fills an object reference with its fields as they are right now (two levels deep). */
  private resolve(value: PyValue, depth = 2): PyValue {
    if (value.t === 'instance') {
      const obj = this.heap.get(value.id);
      if (!obj) return value;
      return { t: 'instance', id: value.id, cls: value.cls, fields: [...obj.fields.entries()].map(([k, b]) => [k, depth > 0 ? this.resolve(b.value, depth - 1) : b.value] as const) };
    }
    if (value.t === 'bound') return { ...value, self: this.resolve(value.self, depth) };
    return value;
  }

  private sourceSpan(mod: ModuleState, span: Span): SourceSpan {
    const start = positionAt(mod.lineStarts, span.from);
    const end = positionAt(mod.lineStarts, span.to);
    return { path: mod.path, startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
  }

  private text(mod: ModuleState, span: Span): string {
    return mod.ast.source.slice(span.from, span.to);
  }

  private get nextId(): number {
    return this.steps.length;
  }

  private recordAt(mod: ModuleState, span: Span, f: StepFields): number {
    if (this.steps.length >= this.maxSteps) throw new StopSignal('limit', `Stopped after ${this.maxSteps} steps to keep the browser responsive.`);
    const id = this.steps.length;
    this.steps.push({
      id,
      kind: f.kind,
      role: f.role,
      title: f.title,
      span: this.sourceSpan(mod, span),
      code: this.text(mod, span),
      inputs: (f.inputs ?? []).map((i) => ({ ...i, value: this.resolve(i.value) })),
      output: f.output ? this.resolve(f.output) : null,
      target: f.target ?? null,
      selectedIndex: f.selectedIndex ?? null,
      frameId: this.frames.length ? this.frame.id : -1,
      frames: this.snapshot(),
      consoleLength: this.console.length,
      explanation: { what: f.what, why: f.why },
      notes: f.notes ?? [],
      usedBy: null,
      evidence: f.evidence ?? 'simulated',
    });
    return id;
  }

  private input(mod: ModuleState, expr: Expr | null, ev: Ev, role: StepInput['role'], label?: string, name?: string): StepInput {
    return {
      label: label ?? (expr ? this.text(mod, expr.span) : ''),
      value: ev.value,
      fromStep: ev.step,
      fromVariable: ev.variable,
      role,
      ...(name !== undefined ? { name } : {}),
    };
  }

  private skip(mod: ModuleState, span: Span, reason: string) {
    this.skipped.push({ reason, span: this.sourceSpan(mod, span) });
  }

  // ---- Statements --------------------------------------------------------------

  private execBlock(stmts: readonly Stmt[], mod: ModuleState): void {
    for (const s of stmts) this.exec(s, mod);
  }

  private exec(s: Stmt, mod: ModuleState): void {
    try {
      this.execInner(s, mod);
    } catch (err) {
      if ((err instanceof PyError || err instanceof UnsupportedError) && !err.recorded) {
        err.span ??= s.type === 'FunctionDef' || s.type === 'ClassDef' ? s.headerSpan : s.span;
        this.recordFailure(err, mod, err.span);
      }
      throw err;
    }
  }

  private execInner(s: Stmt, mod: ModuleState): void {
    switch (s.type) {
      case 'Expr': {
        if (s.isDocstring) {
          this.skip(mod, s.span, 'Docstring (a string with no effect when run)');
          return;
        }
        const ev = this.eval(s.value, mod);
        if (ev.step === null) {
          this.recordAt(mod, s.span, {
            kind: 'operation',
            role: 'value',
            title: 'Evaluate (result unused)',
            inputs: [this.input(mod, s.value, ev, 'value')],
            output: ev.value,
            target: { kind: 'next' },
            what: `Evaluates \`${this.text(mod, s.value.span)}\` → ${v(ev.value)}. The result is not stored.`,
            why: 'An expression on its own line runs, but its value is discarded.',
          });
        }
        return;
      }
      case 'Assign':
        return this.assign(s, mod);
      case 'AugAssign': {
        if (s.target.type !== 'Name' && s.target.type !== 'Attribute') throw new UnsupportedError('Augmented assignment to items is not simulated yet.', s.span);
        const targetName = s.target.type === 'Name' ? s.target.id : this.text(mod, s.target.span);
        const current = s.target.type === 'Name' ? this.lookup(s.target.id, s.target.span, mod) : this.eval(s.target, mod);
        const operand = this.eval(s.value, mod);
        const result = binaryOp(s.op, current.value, operand.value);
        const id = this.nextId;
        this.bindTarget(s.target, result, id, mod);
        this.recordAt(mod, s.span, {
          kind: 'assign',
          role: 'variable',
          title: `Update with ${s.op}=`,
          inputs: [this.input(mod, s.target, current, 'operand'), this.input(mod, s.value, operand, 'operand')],
          output: result,
          target: { kind: 'variable', names: [targetName], frameId: this.frame.id },
          what: `\`${targetName}\` was ${v(current.value)}; \`${targetName} ${s.op}= ${this.text(mod, s.value.span)}\` makes it ${v(result)}.`,
          why: `\`${s.op}=\` applies \`${s.op}\` to the current value and stores the result back in the same variable.`,
        });
        return;
      }
      case 'Return': {
        const call = this.calls[this.calls.length - 1];
        if (!call || this.frame.kind !== 'function') throw new PyError('SyntaxError', "'return' outside function");
        const ev: Ev = s.value ? this.eval(s.value, mod) : { value: NONE, step: null, variable: null };
        const caller = this.frames[this.frames.length - 2];
        const id = this.recordAt(mod, s.span, {
          kind: 'return',
          role: 'return',
          title: 'Return to caller',
          inputs: s.value ? [this.input(mod, s.value, ev, 'value')] : [],
          output: ev.value,
          target: { kind: 'return', callerFrameId: call.callerFrameId, callStep: call.callStep },
          what: `Sends ${v(ev.value)} back from \`${this.frame.name}\` to ${caller ? (caller.kind === 'module' ? `the module code of ${caller.module.path}` : `\`${caller.name}\` in ${caller.module.path}`) : 'the caller'}.`,
          why: '`return` ends the function and hands its value to the expression that called it.',
        });
        throw new ReturnSignal(ev.value, id);
      }
      case 'If': {
        for (const branch of s.branches) {
          const test = this.eval(branch.test, mod);
          const taken = truthy(test.value);
          this.recordAt(mod, branch.span, {
            kind: 'decision',
            role: 'decision',
            title: taken ? 'Condition true → enter branch' : 'Condition false → skip branch',
            inputs: [this.input(mod, branch.test, test, 'condition')],
            output: { t: 'bool', v: taken },
            target: { kind: 'branch', taken },
            what: `\`${this.text(mod, branch.test.span)}\` is ${v(test.value)}, which counts as ${taken ? 'True' : 'False'}.`,
            why: taken ? 'The indented block under this condition runs.' : 'The block is skipped; Python checks the next branch, if any.',
          });
          if (taken) {
            this.execBlock(branch.body, mod);
            return;
          }
        }
        if (s.orelse && s.elseSpan) {
          this.recordAt(mod, s.elseSpan, {
            kind: 'decision',
            role: 'decision',
            title: 'No condition true → else',
            target: { kind: 'branch', taken: true },
            what: 'None of the conditions above were true, so the `else` block runs.',
            why: '`else` catches every case the earlier conditions did not.',
          });
          this.execBlock(s.orelse, mod);
        }
        return;
      }
      case 'For': {
        const iterable = this.eval(s.iter, mod);
        const items = iterate(iterable.value, this.maxIterations);
        if (items.length > this.maxIterations) throw new StopSignal('limit', `Loop has ${items.length} iterations; the simulation stops above ${this.maxIterations}.`);
        let i = 0;
        for (const item of items) {
          i++;
          const id = this.nextId;
          const names = this.bindTarget(s.target, item, id, mod);
          this.recordAt(mod, s.headerSpan, {
            kind: 'loop',
            role: 'loop',
            title: `Iteration ${i} of ${items.length}`,
            inputs: [this.input(mod, s.iter, iterable, 'iterable')],
            output: item,
            selectedIndex: i - 1,
            target: { kind: 'variable', names, frameId: this.frame.id },
            what: `Takes item ${i} of ${items.length} from \`${this.text(mod, s.iter.span)}\`: ${v(item)} goes into \`${names.join(', ')}\`.`,
            why: 'A `for` loop runs its block once per item, in order.',
          });
          try {
            this.execBlock(s.body, mod);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (signal instanceof ContinueSignal) continue;
            throw signal;
          }
        }
        this.recordAt(mod, s.headerSpan, {
          kind: 'loop',
          role: 'loop',
          title: 'Loop finished',
          inputs: [this.input(mod, s.iter, iterable, 'iterable')],
          target: { kind: 'next' },
          what: `The loop over \`${this.text(mod, s.iter.span)}\` is done after ${i} iteration${i === 1 ? '' : 's'}.`,
          why: 'Execution continues with the first statement after the loop.',
        });
        return;
      }
      case 'While': {
        let count = 0;
        for (;;) {
          const test = this.eval(s.test, mod);
          const taken = truthy(test.value);
          this.recordAt(mod, s.headerSpan, {
            kind: 'decision',
            role: 'loop',
            title: taken ? 'Loop condition true → repeat' : 'Loop condition false → exit',
            inputs: [this.input(mod, s.test, test, 'condition')],
            output: { t: 'bool', v: taken },
            target: { kind: 'branch', taken },
            what: `\`${this.text(mod, s.test.span)}\` is ${v(test.value)}.`,
            why: taken ? 'The loop body runs again.' : 'The loop ends.',
          });
          if (!taken) return;
          if (++count > this.maxIterations) throw new StopSignal('limit', `Stopped after ${this.maxIterations} loop iterations.`);
          try {
            this.execBlock(s.body, mod);
          } catch (signal) {
            if (signal instanceof BreakSignal) return;
            if (signal instanceof ContinueSignal) continue;
            throw signal;
          }
        }
      }
      case 'FunctionDef': {
        if (s.decorators.length > 0) throw new UnsupportedError('Decorators are not simulated yet.', s.headerSpan);
        if (s.isAsync) throw new UnsupportedError('Async functions are not simulated.', s.headerSpan);
        const qualname = this.frame.kind === 'function' ? `${this.frame.name}.<locals>.${s.name}` : s.name;
        const fn: FunctionValue = { def: s, path: mod.path, qualname };
        const id = this.nextId;
        this.bind(s.name, { t: 'function', fn }, id);
        this.recordAt(mod, s.headerSpan, {
          kind: 'define',
          role: 'function',
          title: 'Define function',
          output: { t: 'function', fn },
          target: { kind: 'variable', names: [s.name], frameId: this.frame.id },
          what: `Creates the function \`${s.name}(${s.params.map((p) => p.name).join(', ')})\` and stores it under the name \`${s.name}\`.`,
          why: 'Running `def` only defines the function; its body runs later, each time it is called.',
        });
        return;
      }
      case 'ClassDef':
        return this.defineClass(s, mod);
      case 'Import':
        for (const n of s.names) this.importName(n.name, n.asname, s.span, mod);
        return;
      case 'ImportFrom':
        return this.importFrom(s, mod);
      case 'Pass':
        this.skip(mod, s.span, '`pass` does nothing');
        return;
      case 'Break':
        throw new BreakSignal();
      case 'Continue':
        throw new ContinueSignal();
      case 'Unsupported':
        throw new UnsupportedError(s.reason, s.span);
    }
  }

  private assign(s: Extract<Stmt, { type: 'Assign' }>, mod: ModuleState): void {
    const value = this.eval(s.value, mod);
    const id = this.nextId;
    const names: string[] = [];
    for (const target of s.targets) names.push(...this.bindTarget(target, value.value, id, mod));
    const valueText = this.text(mod, s.value.span);
    const fromExpression = value.step !== null && value.variable === null;
    this.recordAt(mod, s.span, {
      kind: 'assign',
      role: 'variable',
      title: names.length > 1 ? 'Unpack into variables' : 'Store in variable',
      inputs: [this.input(mod, s.value, value, 'value')],
      output: value.value,
      target: { kind: 'variable', names, frameId: this.frame.id },
      what: `Stores ${v(value.value)} (${typeLabel(value.value)}) in \`${names.join('`, `')}\`.`,
      why: fromExpression
        ? `The right-hand side \`${valueText.length > 40 ? valueText.slice(0, 39) + '…' : valueText}\` was evaluated first; \`=\` gives its result a name.`
        : '`=` binds the value on the right to the name on the left.',
    });
  }

  /** Binds an assignment / loop target. Returns the bound names. */
  private bindTarget(target: Expr, value: PyValue, stepId: number, mod: ModuleState): string[] {
    if (target.type === 'Name') {
      this.bind(target.id, value, stepId);
      return [target.id];
    }
    if (target.type === 'Tuple' || target.type === 'List') {
      const items = iterate(value, this.maxIterations);
      if (items.length !== target.elts.length) {
        throw new PyError('ValueError', items.length > target.elts.length ? `too many values to unpack (expected ${target.elts.length})` : `not enough values to unpack (expected ${target.elts.length}, got ${items.length})`);
      }
      return target.elts.flatMap((t, i) => this.bindTarget(t, items[i]!, stepId, mod));
    }
    if (target.type === 'Attribute') {
      const base = this.eval(target.value, mod).value;
      if (base.t !== 'instance') throw new UnsupportedError(`Setting \`.${target.attr}\` on ${typeName(base)} is not simulated yet.`, target.span);
      this.heap.get(base.id)!.fields.set(target.attr, { value, setAt: stepId });
      return [this.text(mod, target.span)];
    }
    throw new UnsupportedError('Assigning to list or dictionary items is not simulated yet.', target.span);
  }

  private bind(name: string, value: PyValue, setAt: number | null) {
    this.frame.locals.set(name, { value, setAt });
  }

  // ---- Imports ---------------------------------------------------------------

  private importName(name: string, asname: string | null, span: Span, mod: ModuleState) {
    const path = this.resolveModule(name, 0, mod.path);
    const bindAs = asname ?? name.split('.')[0]!;
    if (path) {
      if (name.includes('.') && !asname) throw new UnsupportedError('Dotted project imports without `as` are not simulated yet.', span);
      const target = this.moduleFor(path)!;
      const loading = target.status === 'new';
      if (loading) this.recordImportStart(mod, span, name, path);
      this.execModule(target, false);
      const value: PyValue = { t: 'module', name, origin: 'project', modelled: true, path };
      const id = this.nextId;
      this.bind(bindAs, value, id);
      this.recordAt(mod, span, {
        kind: 'import',
        role: 'function',
        title: 'Import module',
        output: value,
        target: { kind: 'variable', names: [bindAs], frameId: this.frame.id },
        what: `\`${bindAs}\` now refers to the project module ${path}.`,
        why: 'Importing runs the module once and gives this file a name to reach its contents.',
      });
      return;
    }
    const root = name.split('.')[0]!;
    const modelled = root in MODELLED_LIBRARIES;
    const value: PyValue = { t: 'module', name, origin: 'library', modelled };
    const id = this.nextId;
    this.bind(bindAs, value, id);
    this.recordAt(mod, span, {
      kind: 'import',
      role: 'function',
      title: 'Import library',
      output: value,
      target: { kind: 'variable', names: [bindAs], frameId: this.frame.id },
      what: `\`${bindAs}\` refers to the external library \`${name}\`.`,
      why: modelled
        ? `Some ${MODELLED_LIBRARIES[root]} operations are modelled by the simulation in JavaScript; the real library is not loaded.`
        : `\`${name}\` is not in this project and is not modelled. Using it will stop the simulation.`,
    });
  }

  private recordImportStart(mod: ModuleState, span: Span, name: string, path: string) {
    this.recordAt(mod, span, {
      kind: 'import',
      role: 'function',
      title: 'Load project module',
      target: { kind: 'next' },
      what: `\`${name}\` is found in this project at ${path}. Python runs that file once before continuing here.`,
      why: 'The first import of a module executes its top-level code (definitions, assignments).',
    });
  }

  private importFrom(s: Extract<Stmt, { type: 'ImportFrom' }>, mod: ModuleState) {
    const moduleLabel = `${'.'.repeat(s.level)}${s.module ?? ''}`;
    const path = this.resolveModule(s.module, s.level, mod.path);
    if (path) {
      const target = this.moduleFor(path)!;
      if (target.status === 'new') this.recordImportStart(mod, s.span, moduleLabel, path);
      this.execModule(target, false);
      const names: string[] = [];
      const values: PyValue[] = [];
      const id = this.nextId;
      for (const n of s.names) {
        let binding = target.globals.get(n.name);
        if (!binding) {
          const sub = this.resolveModule(n.name, 1, path);
          if (sub) {
            this.execModule(this.moduleFor(sub)!, false);
            binding = { value: { t: 'module', name: n.name, origin: 'project', modelled: true, path: sub }, setAt: null };
          }
        }
        if (!binding) throw new PyError('ImportError', `cannot import name '${n.name}' from '${moduleLabel}' (${path})`);
        const local = n.asname ?? n.name;
        this.bind(local, binding.value, id);
        names.push(local);
        values.push(binding.value);
      }
      this.recordAt(mod, s.span, {
        kind: 'import',
        role: 'function',
        title: 'Import names',
        inputs: names.map((name, i) => ({ label: name, value: values[i]!, fromStep: target.globals.get(s.names[i]!.name)?.setAt ?? null, fromVariable: null, role: 'value' as const })),
        output: values.length === 1 ? values[0]! : null,
        target: { kind: 'variable', names, frameId: this.frame.id },
        what: `\`${names.join('`, `')}\` from ${path} can now be used in ${mod.path}.`,
        why: '`from … import name` copies a reference to the name into this file.',
      });
      return;
    }
    const root = (s.module ?? '').split('.')[0]!;
    if (s.level > 0) throw new PyError('ImportError', `attempted relative import '${moduleLabel}' could not be resolved in this project`);
    const modelled = root in MODELLED_LIBRARIES;
    const names: string[] = [];
    const id = this.nextId;
    for (const n of s.names) {
      let value: PyValue;
      try {
        value = modelled ? moduleAttribute(s.module!, n.name) : { t: 'module', name: `${s.module}.${n.name}`, origin: 'library', modelled: false };
      } catch {
        value = { t: 'module', name: `${s.module}.${n.name}`, origin: 'library', modelled: false };
      }
      this.bind(n.asname ?? n.name, value, id);
      names.push(n.asname ?? n.name);
    }
    this.recordAt(mod, s.span, {
      kind: 'import',
      role: 'function',
      title: 'Import from library',
      target: { kind: 'variable', names, frameId: this.frame.id },
      what: `\`${names.join('`, `')}\` come from the external library \`${s.module}\`.`,
      why: modelled ? 'Supported operations of this library are modelled in JavaScript.' : 'This library is not modelled; using these names will stop the simulation.',
    });
  }

  // ---- Expressions -------------------------------------------------------------

  private lookup(name: string, span: Span, mod: ModuleState): Ev {
    const local = this.frame.locals.get(name);
    if (local) return { value: local.value, step: local.setAt, variable: name };
    const global = this.frame.module.globals.get(name);
    if (global) return { value: global.value, step: global.setAt, variable: name };
    if (BUILTINS.has(name)) return { value: { t: 'builtin', name }, step: null, variable: null };
    if (KNOWN_UNMODELLED_BUILTINS.has(name)) throw new UnsupportedError(`The built-in \`${name}\` is not modelled yet.`, span);
    void mod;
    throw new PyError('NameError', `name '${name}' is not defined`);
  }

  private eval(e: Expr, mod: ModuleState): Ev {
    try {
      return this.evalInner(e, mod);
    } catch (err) {
      if ((err instanceof PyError || err instanceof UnsupportedError) && !err.recorded) {
        err.span ??= e.span;
        this.recordFailure(err, mod, err.span);
      }
      throw err;
    }
  }

  private evalInner(e: Expr, mod: ModuleState): Ev {
    const override = this.overrides.get(overrideKey(mod.path, e.span));
    if (override) return { value: override, step: null, variable: null };

    switch (e.type) {
      case 'Constant':
        return { value: constantValue(e), step: null, variable: null };
      case 'Name':
        return this.lookup(e.id, e.span, mod);
      case 'List':
      case 'Tuple': {
        const items = e.elts.map((x) => this.eval(x, mod).value);
        return { value: { t: e.type === 'List' ? 'list' : 'tuple', items }, step: null, variable: null };
      }
      case 'Dict': {
        const entries = e.keys.map((k, i) => [this.eval(k, mod).value, this.eval(e.values[i]!, mod).value] as const);
        return { value: { t: 'dict', entries }, step: null, variable: null };
      }
      case 'BinOp': {
        const left = this.eval(e.left, mod);
        const right = this.eval(e.right, mod);
        const result = binaryOp(e.op, left.value, right.value);
        const name = OP_NAMES[e.op] ?? `Apply ${e.op}`;
        const step = this.recordAt(mod, e.span, {
          kind: 'operation',
          role: 'value',
          title: name,
          inputs: [this.input(mod, e.left, left, 'operand'), this.input(mod, e.right, right, 'operand')],
          output: result,
          target: { kind: 'next' },
          what: `${name}: ${v(left.value)} ${e.op} ${v(right.value)} → ${v(result)}.`,
          why: `\`${this.text(mod, e.span)}\` must be computed before its result can be used.`,
          notes: arithmeticNotes(e.op, left.value, right.value, result),
        });
        return { value: result, step, variable: null };
      }
      case 'BoolOp': {
        const left = this.eval(e.left, mod);
        const shortCircuit = e.op === 'and' ? !truthy(left.value) : truthy(left.value);
        const inputs = [this.input(mod, e.left, left, 'operand')];
        let result = left.value;
        if (!shortCircuit) {
          const right = this.eval(e.right, mod);
          inputs.push(this.input(mod, e.right, right, 'operand'));
          result = right.value;
        }
        const step = this.recordAt(mod, e.span, {
          kind: 'operation',
          role: 'decision',
          title: `\`${e.op}\``,
          inputs,
          output: result,
          target: { kind: 'next' },
          what: shortCircuit
            ? `\`${e.op}\` stops early: the left side ${v(left.value)} already decides the result.`
            : `\`${e.op}\` evaluates both sides; the result is the right side ${v(result)}.`,
          why: '`and`/`or` return one of their operands and skip the right side when the left side decides.',
        });
        return { value: result, step, variable: null };
      }
      case 'Compare': {
        let left = this.eval(e.left, mod);
        const inputs = [this.input(mod, e.left, left, 'operand')];
        let result = true;
        for (let i = 0; i < e.ops.length; i++) {
          const right = this.eval(e.comparators[i]!, mod);
          inputs.push(this.input(mod, e.comparators[i]!, right, 'operand'));
          if (!compareOp(e.ops[i]!, left.value, right.value)) {
            result = false;
            break;
          }
          left = right;
        }
        const value: PyValue = { t: 'bool', v: result };
        const step = this.recordAt(mod, e.span, {
          kind: 'operation',
          role: 'decision',
          title: 'Compare',
          inputs,
          output: value,
          target: { kind: 'next' },
          what: `\`${this.text(mod, e.span)}\` → ${result ? 'True' : 'False'}.`,
          why: 'A comparison produces True or False, usually to decide which code runs next.',
        });
        return { value, step, variable: null };
      }
      case 'UnaryOp': {
        const operand = this.eval(e.operand, mod);
        const result = unaryOp(e.op, operand.value);
        if (e.op === '-' && e.operand.type === 'Constant') return { value: result, step: null, variable: null };
        const step = this.recordAt(mod, e.span, {
          kind: 'operation',
          role: e.op === 'not' ? 'decision' : 'value',
          title: e.op === 'not' ? 'Logical not' : e.op === '-' ? 'Negate' : `Unary ${e.op}`,
          inputs: [this.input(mod, e.operand, operand, 'operand')],
          output: result,
          target: { kind: 'next' },
          what: `\`${this.text(mod, e.span)}\` → ${v(result)}.`,
          why: `\`${e.op}\` transforms a single value.`,
        });
        return { value: result, step, variable: null };
      }
      case 'IfExp': {
        const test = this.eval(e.test, mod);
        const taken = truthy(test.value);
        const chosen = this.eval(taken ? e.body : e.orelse, mod);
        const step = this.recordAt(mod, e.span, {
          kind: 'decision',
          role: 'decision',
          title: 'Conditional expression',
          inputs: [this.input(mod, e.test, test, 'condition'), this.input(mod, taken ? e.body : e.orelse, chosen, 'value')],
          output: chosen.value,
          target: { kind: 'next' },
          what: `The condition is ${taken ? 'True' : 'False'}, so the value is ${v(chosen.value)}.`,
          why: '`a if condition else b` picks one of two values.',
        });
        return { value: chosen.value, step, variable: null };
      }
      case 'Attribute':
        return this.attribute(e, mod);
      case 'Subscript': {
        const base = this.eval(e.value, mod);
        const index = this.eval(e.index, mod);
        const selection = subscript(base.value, index.value);
        const container = base.value.t === 'iloc' ? base.value.series : base.value;
        const isIloc = base.value.t === 'iloc';
        const pos = selection.position;
        const step = this.recordAt(mod, e.span, {
          kind: 'index',
          role: 'collection',
          title: isIloc ? 'Select by position (.iloc)' : 'Select element by index',
          inputs: [
            this.input(mod, e.value, { ...base, value: container }, 'receiver'),
            this.input(mod, e.index, index, 'index'),
          ],
          output: selection.value,
          selectedIndex: pos,
          target: { kind: 'next' },
          what: `${isIloc ? 'Position' : 'Index'} ${v(index.value)} of \`${isIloc && e.value.type === 'Attribute' ? this.text(mod, e.value.value.span) : this.text(mod, e.value.span)}\`${pos !== null && pos !== numericOf(index.value) ? ` (position ${pos})` : ''} holds ${v(selection.value)} (${typeLabel(selection.value)}).`,
          why: isIloc
            ? '`.iloc[...]` selects by position (0 = first), regardless of the index labels.'
            : `\`[${this.text(mod, e.index.span)}]\` picks one element; positions start at 0.`,
        });
        return { value: selection.value, step, variable: null };
      }
      case 'Call':
        return this.call(e, mod);
      case 'Unsupported':
        throw new UnsupportedError(e.reason, e.span);
    }
  }

  private attribute(e: Extract<Expr, { type: 'Attribute' }>, mod: ModuleState): Ev {
    const base = this.eval(e.value, mod);
    const value = base.value;
    let result: PyValue;
    if (value.t === 'module') {
      if (value.origin === 'project' && value.path) {
        const target = this.moduleFor(value.path)!;
        const binding = target.globals.get(e.attr);
        if (!binding) throw new PyError('AttributeError', `module '${value.name}' has no attribute '${e.attr}'`);
        return { value: binding.value, step: binding.setAt, variable: null };
      }
      if (!value.modelled) throw new UnsupportedError(`\`${value.name}.${e.attr}\`: the library \`${value.name}\` is not modelled.`, e.span);
      result = moduleAttribute(value.name, e.attr);
    } else if (value.t === 'instance') {
      return this.instanceAttribute(value, base, e, mod);
    } else if (value.t === 'class') {
      const cls = this.classState(value);
      const member = cls ? this.lookupMember(cls, e.attr) : null;
      if (!member) throw new PyError('AttributeError', `type object '${value.name}' has no attribute '${e.attr}'`);
      if (member.kind === 'attr') return { value: member.value, step: null, variable: null };
      if (member.kind === 'unsupported') throw new UnsupportedError(member.reason, e.span);
      if (member.kind === 'property') throw new UnsupportedError('Reading a property from the class itself is not simulated.', e.span);
      return { value: { t: 'function', fn: member.fn }, step: null, variable: null };
    } else if (value.t === 'series' || value.t === 'ndarray' || value.t === 'dataframe') {
      result = objectAttribute(value, e.attr);
    } else {
      throw new UnsupportedError(`Attribute \`.${e.attr}\` of ${typeName(value)} is not simulated yet.`, e.span);
    }
    // Indexers, methods and library callables are intermediate: the following call/subscript step shows them.
    if (result.t === 'method' || result.t === 'iloc' || result.t === 'builtin') return { value: result, step: base.step, variable: base.variable };
    const step = this.recordAt(mod, e.span, {
      kind: 'operation',
      role: 'value',
      title: `Read .${e.attr}`,
      inputs: [this.input(mod, e.value, base, 'receiver')],
      output: result,
      target: { kind: 'next' },
      what: `\`${this.text(mod, e.span)}\` → ${v(result)}.`,
      why: `\`.${e.attr}\` reads a property of ${typeName(value)}.`,
    });
    return { value: result, step, variable: null };
  }

  private call(e: Extract<Expr, { type: 'Call' }>, mod: ModuleState): Ev {
    const callee = this.eval(e.func, mod);
    const args = e.args.map((a) => ({ expr: a, ev: this.eval(a, mod) }));
    const kwargs = e.keywords.map((k) => ({ kw: k, ev: this.eval(k.value, mod) }));
    const argValues = args.map((a) => a.ev.value);
    const kwMap = new Map(kwargs.map((k) => [k.kw.name, k.ev.value] as const));
    const inputs: StepInput[] = [
      ...args.map((a) => this.input(mod, a.expr, a.ev, 'argument')),
      ...kwargs.map((k) => this.input(mod, k.kw.value, k.ev, 'argument', `${k.kw.name}=${this.text(mod, k.kw.value.span)}`, k.kw.name)),
    ];
    const fn = callee.value;
    const calleeText = this.text(mod, e.func.span);

    switch (fn.t) {
      case 'function':
        return this.callUser(fn.fn, argValues, kwMap, inputs, e.span, mod, calleeText);
      case 'bound': {
        const member = this.lookupMember(this.objectClass(fn.self), fn.fn.def.name);
        if (member?.kind === 'async') throw new UnsupportedError('Async methods (`async def`) are not simulated.', e.span);
        const receiverExpr = e.func.type === 'Attribute' ? e.func.value : e.func;
        const selfInput: StepInput = { label: this.text(mod, receiverExpr.span), value: fn.self, fromStep: callee.step, fromVariable: callee.variable, role: 'receiver', name: 'self' };
        return this.callUser(fn.fn, [fn.self, ...argValues], kwMap, [selfInput, ...inputs], e.span, mod, calleeText);
      }
      case 'builtin':
        if (fn.name === 'pandas.read_csv') return this.readCsv(argValues, kwMap, inputs, e, mod, calleeText);
        if (fn.name.includes('.')) {
          const result = callLibraryFunction(fn.name, argValues, kwMap);
          const step = this.recordAt(mod, e.span, {
            kind: 'builtin',
            role: 'collection',
            title: fn.name === 'pandas.Series' ? 'Create pandas Series' : fn.name === 'numpy.array' ? 'Create NumPy array' : `Call ${fn.name}`,
            inputs,
            output: result,
            target: { kind: 'next' },
            what: `\`${calleeText}(…)\` builds ${v(result)} (${typeLabel(result)}).`,
            why: `${fn.name} is a library function; its behaviour here is a JavaScript model.`,
          });
          return { value: result, step, variable: null };
        }
        return this.callBuiltin(fn.name, argValues, kwMap, inputs, e, mod);
      case 'method': {
        const result = callMethod(fn, argValues, kwMap);
        const receiverExpr = e.func.type === 'Attribute' ? e.func.value : e.func;
        const step = this.recordAt(mod, e.span, {
          kind: 'method',
          role: 'function',
          title: `Call .${fn.name}()`,
          inputs: [this.input(mod, receiverExpr, { value: fn.self, step: callee.step, variable: callee.variable }, 'receiver'), ...inputs],
          output: result,
          target: { kind: 'next' },
          what: methodDescription(fn.name, this.text(mod, receiverExpr.span), fn.self, result, e.keywords.find((k) => k.name === 'dtype') ? this.text(mod, e.keywords.find((k) => k.name === 'dtype')!.value.span) : null),
          why: `\`.${fn.name}()\` is a ${fn.owner === 'Series' ? 'pandas' : 'NumPy'} method; the simulation models it in JavaScript.`,
        });
        return { value: result, step, variable: null };
      }
      case 'class': {
        const cls = this.classState(fn);
        if (!cls) throw new UnsupportedError(`Creating \`${fn.name}\` objects is not simulated.`, e.span);
        return this.instantiate(cls, argValues, kwMap, inputs, e.span, mod);
      }
      case 'module':
        if (!fn.modelled) throw new UnsupportedError(`\`${calleeText}\` comes from the library \`${fn.name}\`, which is not modelled.`, e.span);
        throw new PyError('TypeError', `'module' object is not callable`);
      default:
        throw new PyError('TypeError', `'${typeName(fn)}' object is not callable`);
    }
  }

  private callBuiltin(
    name: string,
    args: readonly PyValue[],
    kwargs: ReadonlyMap<string, PyValue>,
    inputs: StepInput[],
    e: Extract<Expr, { type: 'Call' }>,
    mod: ModuleState,
  ): Ev {
    const allowed: Record<string, string[]> = { print: ['sep', 'end'], sum: ['start'], round: ['ndigits'], sorted: ['reverse'] };
    for (const key of kwargs.keys()) {
      if (!(allowed[name] ?? []).includes(key)) throw new UnsupportedError(`Keyword \`${key}=\` of ${name}() is not modelled.`, e.span);
    }
    const notes: string[] = [];
    const arity = (min: number, max: number) => {
      if (args.length < min || args.length > max) {
        throw new PyError('TypeError', `${name}() takes ${min === max ? min : `from ${min} to ${max}`} argument${max === 1 ? '' : 's'} (${args.length} given)`);
      }
    };
    let result: PyValue;
    let what: string;
    let target: StepTarget = { kind: 'next' };
    switch (name) {
      case 'print': {
        const sep = kwargs.get('sep');
        const end = kwargs.get('end');
        if (end && !(end.t === 'str' && end.v === '\n')) throw new UnsupportedError('print(end=…) is not modelled yet.', e.span);
        const sepText = sep ? (sep.t === 'str' ? sep.v : sep.t === 'none' ? ' ' : null) : ' ';
        if (sepText === null) throw new PyError('TypeError', 'sep must be None or a string');
        const text = args.map(pyStrOf).join(sepText);
        this.console.push(...text.split('\n'));
        if (args.some(isApproximatePrint)) notes.push('NumPy/pandas print formatting is approximated.');
        result = NONE;
        target = { kind: 'console' };
        what = `Prints \`${text.length > 60 ? text.slice(0, 59) + '…' : text}\` to the console.`;
        break;
      }
      case 'sum': {
        arity(1, 2);
        let total: PyValue = kwargs.get('start') ?? args[1] ?? { t: 'int', v: 0 };
        const items = iterate(args[0]!, this.maxIterations * 20);
        for (const item of items) total = binaryOp('+', total, item);
        result = total;
        what = `Adds the ${items.length} item${items.length === 1 ? '' : 's'} of \`${inputs[0]?.label}\` → ${v(result)}.`;
        break;
      }
      case 'len': {
        arity(1, 1);
        const x = args[0]!;
        const n =
          x.t === 'str'
            ? [...x.v].length
            : x.t === 'list' || x.t === 'tuple' || x.t === 'ndarray' || x.t === 'series'
              ? x.items.length
              : x.t === 'dict'
                ? x.entries.length
                : x.t === 'range'
                  ? rangeLength(x)
                  : x.t === 'dataframe'
                    ? (x.columns[0]?.items.length ?? 0)
                    : null;
        if (n === null) throw new PyError('TypeError', `object of type '${typeName(x)}' has no len()`);
        result = { t: 'int', v: n };
        what = `\`${inputs[0]?.label}\` has ${n} item${n === 1 ? '' : 's'}.`;
        break;
      }
      case 'float': {
        arity(0, 1);
        const x = args[0];
        if (!x) result = { t: 'float', v: 0 };
        else if (x.t === 'str') {
          const t = x.v.trim().toLowerCase();
          const parsed = t === 'inf' || t === 'infinity' ? Infinity : t === '-inf' ? -Infinity : t === 'nan' ? NaN : /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(t) ? Number(t) : null;
          if (parsed === null) throw new PyError('ValueError', `could not convert string to float: '${x.v}'`);
          result = { t: 'float', v: parsed };
        } else {
          const n = numericOf(x);
          if (n === null) throw new PyError('TypeError', `float() argument must be a string or a real number, not '${typeName(x)}'`);
          result = { t: 'float', v: n };
        }
        what = x ? `Converts ${v(x)} (${typeLabel(x)}) to the Python float ${v(result)}.` : 'float() with no argument is 0.0.';
        break;
      }
      case 'int': {
        arity(0, 1);
        const x = args[0];
        if (!x) result = { t: 'int', v: 0 };
        else if (x.t === 'str') {
          if (!/^\s*[-+]?\d[\d_]*\s*$/.test(x.v)) throw new PyError('ValueError', `invalid literal for int() with base 10: '${x.v}'`);
          result = { t: 'int', v: Number(x.v.replace(/_/g, '').trim()) };
        } else {
          const n = numericOf(x);
          if (n === null) throw new PyError('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${typeName(x)}'`);
          if (!Number.isFinite(n)) throw new PyError(Number.isNaN(n) ? 'ValueError' : 'OverflowError', Number.isNaN(n) ? 'cannot convert float NaN to integer' : 'cannot convert float infinity to integer');
          result = { t: 'int', v: Math.trunc(n) };
        }
        what = x ? `Converts ${v(x)} to the integer ${v(result)} (dropping any fraction).` : 'int() with no argument is 0.';
        break;
      }
      case 'str':
        arity(0, 1);
        result = { t: 'str', v: args[0] ? pyStrOf(args[0]) : '' };
        what = `Converts to the text ${v(result)}.`;
        break;
      case 'bool':
        arity(0, 1);
        result = { t: 'bool', v: args[0] ? truthy(args[0]) : false };
        what = `Truthiness of the value → ${v(result)}.`;
        break;
      case 'abs': {
        arity(1, 1);
        result = numericOf(args[0]!) !== null && numericOf(args[0]!)! < 0 ? unaryOp('-', args[0]!) : args[0]!;
        if (numericOf(args[0]!) === null) throw new PyError('TypeError', `bad operand type for abs(): '${typeName(args[0]!)}'`);
        what = `Absolute value → ${v(result)}.`;
        break;
      }
      case 'round': {
        arity(1, 2);
        const x = numericOf(args[0]!);
        if (x === null) throw new PyError('TypeError', `type ${typeName(args[0]!)} doesn't define __round__ method`);
        const nd = kwargs.get('ndigits') ?? args[1];
        if (!nd || nd.t === 'none') {
          const floor = Math.floor(x);
          const diff = x - floor;
          const r = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
          result = { t: 'int', v: r };
          if (diff === 0.5) notes.push('Python rounds halves to the nearest even number ("banker\'s rounding").');
        } else {
          const digits = numericOf(nd) ?? 0;
          result = { t: args[0]!.t === 'int' ? 'int' : 'float', v: Number(x.toFixed(Math.max(0, digits))) } as PyValue;
          notes.push('round() with ndigits is approximated; Python rounds the exact binary value.');
        }
        what = `Rounds ${v(args[0]!)} → ${v(result)}.`;
        break;
      }
      case 'min':
      case 'max': {
        const items = args.length === 1 ? iterate(args[0]!, this.maxIterations * 20) : [...args];
        if (items.length === 0) throw new PyError('ValueError', `${name}() iterable argument is empty`);
        result = items.reduce((best, x) => (compareOp(name === 'max' ? '>' : '<', x, best) ? x : best));
        what = `The ${name === 'max' ? 'largest' : 'smallest'} of ${items.length} values is ${v(result)}.`;
        break;
      }
      case 'range': {
        arity(1, 3);
        const nums = args.map((a) => {
          if (a.t !== 'int' && a.t !== 'bool' && !(a.t === 'np-scalar' && a.dtype === 'int64')) throw new PyError('TypeError', `'${typeName(a)}' object cannot be interpreted as an integer`);
          return numericOf(a)!;
        });
        const [start, stop, step] = nums.length === 1 ? [0, nums[0]!, 1] : [nums[0]!, nums[1]!, nums[2] ?? 1];
        if (step === 0) throw new PyError('ValueError', 'range() arg 3 must not be zero');
        result = { t: 'range', start, stop, step };
        what = `Creates ${v(result)} with ${rangeLength(result as Extract<PyValue, { t: 'range' }>)} numbers.`;
        break;
      }
      case 'list':
      case 'tuple':
        arity(0, 1);
        {
          const items = args[0] ? iterate(args[0], this.maxIterations * 20) : [];
          result = { t: name, items };
          what = `Builds a ${name} of ${items.length} item${items.length === 1 ? '' : 's'}.`;
        }
        break;
      case 'sorted': {
        arity(1, 1);
        const items = iterate(args[0]!, this.maxIterations * 20);
        const sorted = [...items].sort((a, b) => (compareOp('<', a, b) ? -1 : compareOp('<', b, a) ? 1 : 0));
        const reverse = kwargs.get('reverse');
        if (reverse && truthy(reverse)) sorted.reverse();
        result = { t: 'list', items: sorted };
        what = `Returns a new sorted list → ${v(result)}.`;
        break;
      }
      default:
        throw new UnsupportedError(`The built-in \`${name}\` is not modelled yet.`, e.span);
    }
    const step = this.recordAt(mod, e.span, {
      kind: name === 'print' ? 'print' : 'builtin',
      role: name === 'print' ? 'value' : 'function',
      title: name === 'print' ? 'Print to console' : `Built-in ${name}()`,
      inputs,
      output: result,
      target,
      what,
      why: name === 'print' ? '`print` writes text to the program output.' : `\`${name}()\` is a Python built-in function.`,
      notes,
    });
    return { value: result, step, variable: null };
  }

  private bindArguments(def: FunctionDef, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>, fnMod: ModuleState): Map<string, PyValue> {
    const bound = new Map<string, PyValue>();
    const positional = def.params.filter((p) => p.kind === 'positional');
    if (def.params.some((p) => p.kind === 'varargs' || p.kind === 'varkw')) throw new UnsupportedError('Functions with *args/**kwargs are not simulated yet.', def.headerSpan);
    if (args.length > positional.length) {
      throw new PyError('TypeError', `${def.name}() takes ${positional.length} positional argument${positional.length === 1 ? '' : 's'} but ${args.length} were given`);
    }
    args.forEach((a, i) => bound.set(positional[i]!.name, a));
    for (const [key, value] of kwargs) {
      const param = def.params.find((p) => p.name === key);
      if (!param) throw new PyError('TypeError', `${def.name}() got an unexpected keyword argument '${key}'`);
      if (bound.has(key)) throw new PyError('TypeError', `${def.name}() got multiple values for argument '${key}'`);
      bound.set(key, value);
    }
    const missing: string[] = [];
    for (const p of def.params) {
      if (bound.has(p.name)) continue;
      if (p.defaultValue) bound.set(p.name, this.eval(p.defaultValue, fnMod).value);
      else missing.push(p.name);
    }
    if (missing.length) {
      throw new PyError('TypeError', `${def.name}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${missing.map((m) => `'${m}'`).join(' and ')}`);
    }
    return bound;
  }

  private callUser(
    fn: FunctionValue,
    args: readonly PyValue[],
    kwargs: ReadonlyMap<string, PyValue>,
    inputs: StepInput[],
    callSpan: Span,
    mod: ModuleState,
    calleeText: string,
    synthetic = false,
    existingCallStep: number | null = null,
  ): Ev {
    const fnMod = this.moduleFor(fn.path)!;
    const defLine = positionAt(fnMod.lineStarts, fn.def.headerSpan.from).line;
    const named = inputs.map((input, i) => (input.name ? input : { ...input, name: fn.def.params.filter((p) => p.kind === 'positional')[i]?.name ?? input.label }));
    const isMethod = fn.qualname.includes('.') && !fn.qualname.includes('<locals>');
    const callStep = existingCallStep ?? this.recordAt(mod, callSpan, {
      kind: 'call',
      role: 'function',
      title: isMethod ? 'Call method' : 'Call function',
      inputs: named,
      target: { kind: 'next' },
      what: synthetic
        ? `The simulation calls \`${fn.def.name}\` with the argument values you entered.`
        : `Calls \`${calleeText}\` (defined in ${fn.path}, line ${defLine}) with ${inputs.length} argument${inputs.length === 1 ? '' : 's'}.`,
      why: synthetic
        ? 'There is no call site for this run: the inputs come from you, not from the code.'
        : 'Python evaluates the arguments first, then jumps into the function body.',
    });
    const bound = this.bindArguments(fn.def, args, kwargs, fnMod);
    const callerFrame = this.frame;
    const locals = new Map<string, Binding>();
    const enterStepId = this.nextId;
    for (const [name, value] of bound) locals.set(name, { value, setAt: enterStepId });
    this.pushFrame({ name: fn.qualname, kind: 'function', locals, module: fnMod });
    this.calls.push({ callStep, callerFrameId: callerFrame.id });
    try {
      this.recordAt(fnMod, fn.def.headerSpan, {
        kind: 'enter',
        role: 'function',
        title: isMethod ? 'Enter method' : 'Enter function',
        inputs: [...bound.entries()].map(([name, value]) => {
          const source = named.find((n) => n.name === name);
          return { label: name, value, fromStep: callStep, fromVariable: source?.fromVariable ?? null, role: 'argument' as const, name };
        }),
        target: { kind: 'params', names: [...bound.keys()], frameId: this.frame.id },
        what: bound.size
          ? `Inside \`${fn.def.name}\`: ${[...bound.entries()].map(([n, val]) => `\`${n}\` = ${v(val)}`).join(', ')}.`
          : `Enters \`${fn.def.name}\` (no parameters).`,
        why: 'Each parameter becomes a local variable holding the matching argument.',
      });
      try {
        this.execBlock(fn.def.body, fnMod);
      } catch (signal) {
        if (signal instanceof ReturnSignal) return { value: signal.value, step: signal.step, variable: null };
        throw signal;
      }
      const end = fn.def.body[fn.def.body.length - 1];
      const step = this.recordAt(fnMod, end ? end.span : fn.def.headerSpan, {
        kind: 'return',
        role: 'return',
        title: 'Function ends → None',
        output: NONE,
        target: { kind: 'return', callerFrameId: callerFrame.id, callStep },
        what: `\`${fn.def.name}\` reached its end without \`return\`, so it returns None.`,
        why: 'A Python function without a return statement returns None.',
      });
      return { value: NONE, step, variable: null };
    } finally {
      this.frames.pop();
      this.calls.pop();
    }
  }

  // ---- Classes and objects ---------------------------------------------------

  private classState(value: Extract<PyValue, { t: 'class' }>): ClassState | null {
    return this.classes.get(`${value.path}::${value.name}`) ?? null;
  }

  private objectClass(value: PyValue): ClassState {
    if (value.t !== 'instance') throw new UnsupportedError(`Expected an object, got ${typeName(value)}.`);
    return this.heap.get(value.id)!.cls;
  }

  private lookupMember(cls: ClassState, name: string): Member | null {
    const own = cls.members.get(name);
    if (own) return own;
    for (const base of cls.bases) {
      const found = this.lookupMember(base, name);
      if (found) return found;
    }
    return null;
  }

  /** Runs a class definition: records its methods and simple class attributes (method bodies run later). */
  private defineClass(s: Extract<Stmt, { type: 'ClassDef' }>, mod: ModuleState) {
    const bases: ClassState[] = [];
    for (const b of s.bases) {
      if (b.type === 'Name' && b.id === 'object') continue;
      const base = this.eval(b, mod).value;
      const state = base.t === 'class' ? this.classState(base) : null;
      if (!state) throw new UnsupportedError(`Inheriting from \`${this.text(mod, b.span)}\` is not simulated.`, b.span);
      bases.push(state);
    }
    const members = new Map<string, Member>();
    const cls: ClassState = { name: s.name, path: mod.path, headerSpan: s.headerSpan, bases, members };
    const described: string[] = [];
    for (const item of s.body) {
      if (item.type === 'FunctionDef') {
        const fn: FunctionValue = { def: item, path: mod.path, qualname: `${s.name}.${item.name}` };
        const deco = item.decorators.map((d) => this.text(mod, d.span));
        if (item.isAsync) members.set(item.name, { kind: 'async', fn });
        else if (deco.length === 0) members.set(item.name, { kind: 'method', fn });
        else if (deco.length === 1 && deco[0] === 'property') members.set(item.name, { kind: 'property', fn });
        else if (deco.length === 1 && deco[0] === 'staticmethod') members.set(item.name, { kind: 'static', fn });
        else members.set(item.name, { kind: 'unsupported', reason: `The decorator ${deco.map((d) => `@${d}`).join(' ')} on \`${item.name}\` is not simulated yet.` });
        described.push(`${item.name}${deco.includes('property') ? ' (property)' : item.isAsync ? ' (async)' : ''}`);
      } else if (item.type === 'Assign' && item.targets.length === 1 && item.targets[0]!.type === 'Name') {
        members.set(item.targets[0].id, { kind: 'attr', value: this.eval(item.value, mod).value });
        described.push(item.targets[0].id);
      } else if (item.type === 'Pass' || (item.type === 'Expr' && item.isDocstring)) {
        continue;
      } else {
        throw new UnsupportedError('This kind of statement inside a class body is not simulated yet.', item.span);
      }
    }
    this.classes.set(`${mod.path}::${s.name}`, cls);
    const value: PyValue = { t: 'class', name: s.name, path: mod.path };
    const id = this.nextId;
    this.bind(s.name, value, id);
    this.recordAt(mod, s.headerSpan, {
      kind: 'define',
      role: 'function',
      title: 'Define class',
      output: value,
      target: { kind: 'variable', names: [s.name], frameId: this.frame.id },
      what: `Creates the class \`${s.name}\`${described.length ? ` with ${described.map((d) => `\`${d}\``).join(', ')}` : ''}.`,
      why: 'A class is a container: it groups the methods (and data) that its objects share. Method bodies run only when called.',
    });
  }

  /** `Cls(args)`: makes a new object and runs `__init__` on it. */
  private instantiate(cls: ClassState, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>, inputs: StepInput[], span: Span, mod: ModuleState): Ev {
    const id = this.nextObjectId++;
    this.heap.set(id, { cls, fields: new Map() });
    const ref: PyValue = { t: 'instance', id, cls: cls.name, fields: [] };
    const init = this.lookupMember(cls, '__init__');
    const createStep = this.recordAt(mod, span, {
      kind: 'call',
      role: 'function',
      title: 'Create object',
      inputs,
      output: ref,
      target: { kind: 'next' },
      what: `Makes a new \`${cls.name}\` object${init?.kind === 'method' ? ' and runs its `__init__` method to fill it in' : ''}.`,
      why: 'Calling a class creates an object: a container with its own data. `__init__` sets its starting values.',
    });
    if (init?.kind === 'method') {
      const selfInput: StepInput = { label: 'self', value: ref, fromStep: createStep, fromVariable: null, role: 'receiver', name: 'self' };
      const result = this.callUser(init.fn, [ref, ...args], kwargs, [selfInput, ...inputs], span, mod, `${cls.name}.__init__`, false, createStep);
      if (result.value.t !== 'none') throw new PyError('TypeError', `__init__() should return None, not '${typeName(result.value)}'`);
    } else if (init) {
      throw new UnsupportedError(`This kind of \`__init__\` is not simulated.`, span);
    } else if (args.length > 0 || kwargs.size > 0) {
      throw new PyError('TypeError', `${cls.name}() takes no arguments`);
    }
    return { value: ref, step: createStep, variable: null };
  }

  /** `obj.name`: a field, a method (bound to obj), a property (runs its getter) or a class attribute. */
  private instanceAttribute(obj: Extract<PyValue, { t: 'instance' }>, base: Ev, e: Extract<Expr, { type: 'Attribute' }>, mod: ModuleState): Ev {
    const state = this.heap.get(obj.id)!;
    const field = state.fields.get(e.attr);
    if (field) return { value: field.value, step: field.setAt, variable: null };
    const member = this.lookupMember(state.cls, e.attr);
    if (!member) throw new PyError('AttributeError', `'${state.cls.name}' object has no attribute '${e.attr}'`);
    switch (member.kind) {
      case 'attr':
        return { value: member.value, step: null, variable: null };
      case 'unsupported':
        throw new UnsupportedError(member.reason, e.span);
      case 'static':
        return { value: { t: 'function', fn: member.fn }, step: null, variable: null };
      case 'property': {
        const selfInput: StepInput = { label: this.text(mod, e.value.span), value: obj, fromStep: base.step, fromVariable: base.variable, role: 'receiver', name: 'self' };
        return this.callUser(member.fn, [obj], new Map(), [selfInput], e.span, mod, this.text(mod, e.span));
      }
      default:
        return { value: { t: 'bound', self: obj, fn: member.fn, cls: state.cls.name }, step: base.step, variable: base.variable };
    }
  }

  // ---- Data files -----------------------------------------------------------------

  /** `pd.read_csv(path)`: reads the project's own CSV file into a table. */
  private readCsv(args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>, inputs: StepInput[], e: Extract<Expr, { type: 'Call' }>, mod: ModuleState, calleeText: string): Ev {
    for (const key of kwargs.keys()) {
      if (key !== 'sep' || (kwargs.get(key)!.t === 'str' && (kwargs.get(key) as { v: string }).v !== ',')) {
        throw new UnsupportedError(`\`${key}=\` of read_csv is not modelled yet.`, e.span);
      }
    }
    const pathValue = args[0];
    if (!pathValue || pathValue.t !== 'str') throw new UnsupportedError('read_csv is only modelled with a file path written as text.', e.span);
    const raw = pathValue.v;
    const files = this.program.dataFiles ?? new Map<string, string>();
    const candidates = [normalisePath(raw), normalisePath(`${dirname(this.entry.path)}/${raw}`), normalisePath(`${dirname(mod.path)}/${raw}`)].filter((c): c is string => !!c);
    const found = candidates.find((c) => files.has(c));
    if (!found) throw new MissingDataError(candidates[0] ?? raw, e.span);
    if (!this.readCsvAssumption) {
      this.readCsvAssumption = true;
      this.assumptions.push('Relative file paths are looked up from the repository root, then from the script’s folder.');
    }
    const table = csvToDataFrame(files.get(found)!, found);
    const rows = table.columns[0]?.items.length ?? 0;
    const step = this.recordAt(mod, e.span, {
      kind: 'builtin',
      role: 'collection',
      title: 'Read CSV file',
      inputs,
      output: table,
      target: { kind: 'next' },
      what: `\`${calleeText}\` reads ${found} from this project: ${rows} row${rows === 1 ? '' : 's'}, columns ${table.columns.map((c) => `\`${c.name}\``).join(', ')}.`,
      why: '`pd.read_csv` turns a CSV file into a table (a DataFrame). Only the data is read; nothing in the file runs.',
    });
    return { value: table, step, variable: null };
  }

  private callEntryMethod(mod: ModuleState, entry: Extract<SimulationEntry, { kind: 'method' }>) {
    const binding = mod.globals.get(entry.className);
    const cls = binding?.value.t === 'class' ? this.classState(binding.value) : null;
    if (!cls) throw new UnsupportedError(`\`${entry.className}\` is not a class in ${mod.path}.`);
    const member = this.lookupMember(cls, entry.method);
    if (!member || member.kind === 'attr') throw new UnsupportedError(`\`${entry.className}\` has no method \`${entry.method}\`.`);
    if (member.kind === 'unsupported') throw new UnsupportedError(member.reason, cls.headerSpan);
    if (member.kind === 'async') throw new UnsupportedError('Async methods (`async def`) are not simulated.', member.fn.def.headerSpan);
    this.assumptions.push(`A \`${entry.className}\` object is made with your values, then \`${entry.method}\` is called on it. This call does not appear in the code.`);
    this.assumptions.push(`${mod.path} is imported (not run as a script), so \`if __name__ == "__main__":\` blocks are skipped.`);
    this.pushFrame({ name: '<simulation>', kind: 'module', locals: new Map(), module: mod });
    try {
      const initInputs: StepInput[] = [...entry.initArgs.entries()].map(([k, value]) => ({ label: k, value, fromStep: null, fromVariable: null, role: 'argument', name: k }));
      const made = this.instantiate(cls, [], entry.initArgs, initInputs, cls.headerSpan, mod);
      this.bind('obj', made.value, made.step);
      const fnMod = this.moduleFor(member.fn.path)!;
      const selfInput: StepInput = { label: 'obj', value: made.value, fromStep: made.step, fromVariable: 'obj', role: 'receiver', name: 'self' };
      const argInputs: StepInput[] = [...entry.args.entries()].map(([k, value]) => ({ label: k, value, fromStep: null, fromVariable: null, role: 'argument', name: k }));
      if (member.kind === 'static') this.callUser(member.fn, [], entry.args, argInputs, member.fn.def.headerSpan, fnMod, entry.method, true);
      else this.callUser(member.fn, [made.value], member.kind === 'property' ? new Map() : entry.args, [selfInput, ...argInputs], member.fn.def.headerSpan, fnMod, `obj.${entry.method}`, true);
    } finally {
      this.frames.pop();
    }
  }

  private callEntryFunction(mod: ModuleState, name: string, args: ReadonlyMap<string, PyValue>) {
    const binding = mod.globals.get(name);
    if (!binding || binding.value.t !== 'function') throw new UnsupportedError(`\`${name}\` is not a top-level function in ${mod.path}.`);
    const fn = binding.value.fn;
    this.assumptions.push(`\`${name}\` is called directly with your inputs; this call does not appear in the code.`);
    this.assumptions.push(`${mod.path} is imported (not run as a script), so \`if __name__ == "__main__":\` blocks are skipped.`);
    const inputs: StepInput[] = [...args.entries()].map(([k, value]) => ({ label: k, value, fromStep: null, fromVariable: null, role: 'argument', name: k }));
    this.pushFrame({ name: '<simulation>', kind: 'module', locals: new Map(), module: mod });
    try {
      this.callUser(fn, [], args, inputs, fn.def.headerSpan, mod, name, true);
    } finally {
      this.frames.pop();
    }
  }
}

const OP_NAMES: Record<string, string> = {
  '+': 'Add',
  '-': 'Subtract',
  '*': 'Multiply',
  '/': 'Divide',
  '//': 'Floor-divide',
  '%': 'Remainder',
  '**': 'Power',
};

function arithmeticNotes(op: string, a: PyValue, b: PyValue, result: PyValue): string[] {
  const notes: string[] = [];
  if (op === '/' && a.t === 'int' && b.t === 'int') notes.push('`/` always produces a float in Python 3, even for two integers.');
  if (result.t === 'float' && !Number.isInteger(result.v) && floatRepr(result.v).length > 12) {
    notes.push('Floating-point results can show tiny rounding differences; Python would show the same digits.');
  }
  return notes;
}

function methodDescription(name: string, receiver: string, self: PyValue, result: PyValue, dtypeSource: string | null): string {
  if (name === 'to_numpy') {
    const dtype = (result as { dtype?: string }).dtype ?? '';
    return `Converts the pandas Series \`${receiver}\` into a NumPy array of ${dtype} values${dtypeSource ? ` (\`dtype=${dtypeSource}\`)` : ''} → ${v(result)}.`;
  }
  return `\`${receiver}.${name}()\` on ${typeLabel(self)} → ${v(result)}.`;
}

function constantValue(e: Extract<Expr, { type: 'Constant' }>): PyValue {
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
      return NONE;
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function moduleNameOf(path: string): string {
  return path.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
}
