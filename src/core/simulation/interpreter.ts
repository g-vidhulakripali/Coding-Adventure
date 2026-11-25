import { computeLineStarts, parsePythonModule, positionAt, type Expr, type FormatPart, type FunctionDef, type Module, type Span, type Stmt } from '../parser/python/ast';
import type { SourceSpan } from '../source-mapping/types';
import { csvToDataFrame, normalisePath } from './csv';
import { MissingDataError, PyError, UnsupportedError } from './errors';
import { callLibraryFunction, callMethod, MODELLED_LIBRARIES, moduleAttribute, objectAttribute, sliceOf, subscript } from './libraries';
import { callContainerMethod, dictSet, hasContainerMethod, uniqueItems } from './containers';
import { convert, formatValue } from './format';
import { compareArrays, hasNumericMethod, logicArrays, setColumn } from './numeric';
import { binaryOp, compareOp, iterate, pyEquals, rangeLength, truthy, unaryOp } from './operators';
import { describeLibrary } from './phrases';
import type { FrameSnapshot, Step, StepInput, StepKind, StepTarget, Trace, VisualRole } from './trace';
import {
  displayValue,
  floatRepr,
  hasUnknown,
  isApproximatePrint,
  NONE,
  pyRepr,
  unknown,
  type Closure,
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
  /** Which way to go at decisions that depend on `?`, keyed by `overrideKey` of the condition. */
  readonly choices?: ReadonlyMap<string, boolean>;
  readonly maxSteps?: number;
  readonly maxDepth?: number;
  readonly maxIterations?: number;
}

export function overrideKey(path: string, span: Span): string {
  return `${path}:${span.from}:${span.to}`;
}

const BUILTINS = new Set([
  'print', 'sum', 'len', 'float', 'int', 'str', 'bool', 'abs', 'round', 'min', 'max', 'range', 'list', 'tuple', 'sorted', 'isinstance', 'any', 'all', 'enumerate', 'zip', 'map', 'filter', 'dict', 'set', 'frozenset', 'reversed', 'repr', 'getattr', 'hasattr',
  'divmod', 'pow', 'format', 'callable', 'next',
]);
/** Built-ins that exist in Python but are not modelled: their results show as `?`. */
const UNMODELLED_BUILTINS = new Set(['open', 'input', 'type', 'setattr', 'delattr', 'iter', 'hash', 'id', 'vars', 'dir', 'eval', 'exec', 'super', 'object', 'globals', 'locals', 'compile', 'bytes', 'bytearray', 'memoryview', 'complex', 'slice', 'property', 'staticmethod', 'classmethod', 'issubclass', 'ord', 'chr', 'hex', 'bin', 'oct', 'ascii', 'breakpoint', 'help', '__import__', '__file__', '__package__', '__spec__', '__doc__', 'NotImplemented']);

/** Python's exception families (child → parent). */
const EXCEPTIONS: Record<string, string> = {
  BaseException: '', Exception: 'BaseException', KeyboardInterrupt: 'BaseException', SystemExit: 'BaseException', GeneratorExit: 'BaseException', ArithmeticError: 'Exception', ZeroDivisionError: 'ArithmeticError', OverflowError: 'ArithmeticError', FloatingPointError: 'ArithmeticError', AssertionError: 'Exception',
  AttributeError: 'Exception', BufferError: 'Exception', EOFError: 'Exception', ImportError: 'Exception', ModuleNotFoundError: 'ImportError', LookupError: 'Exception', IndexError: 'LookupError', KeyError: 'LookupError', MemoryError: 'Exception', NameError: 'Exception', UnboundLocalError: 'NameError', OSError: 'Exception',
  IOError: 'OSError', FileNotFoundError: 'OSError', FileExistsError: 'OSError', PermissionError: 'OSError', NotADirectoryError: 'OSError', IsADirectoryError: 'OSError', TimeoutError: 'OSError', ConnectionError: 'OSError', RuntimeError: 'Exception', RecursionError: 'RuntimeError', NotImplementedError: 'RuntimeError',
  StopIteration: 'Exception', SyntaxError: 'Exception', TypeError: 'Exception', ValueError: 'Exception', UnicodeDecodeError: 'ValueError', UnicodeEncodeError: 'ValueError', Warning: 'Exception', UserWarning: 'Warning', DeprecationWarning: 'Warning', RuntimeWarning: 'Warning', FutureWarning: 'Warning',
};
/** Decorators that do not change what a function computes (caching, registration). */
const TRANSPARENT_DECORATORS = /^(functools\.)?(lru_cache|cache|wraps)\b|^(st|streamlit)\.|^pytest\./;
/** Imported project files larger than this load quietly (no step for each setup line). */
const QUIET_IMPORT_STATEMENTS = 12;
const MAX_QUIET_OPS = 400_000;
/** A comprehension or a sort key longer than this shows as `?` instead of freezing the page. */
const MAX_INLINE_OPS = 40_000;
/** A function that keeps calling itself with values that are not known is left out after this many levels. */
const MAX_UNKNOWN_RECURSION = 4;
/** Why some calls can never be computed in the browser. */
const OUTSIDE: Record<string, string> = {
  open: 'It reads or writes a file on the computer. The simulation never touches files.',
  'os.path.exists': 'It looks at the files on the computer. The simulation never touches files.',
  'os.path.isfile': 'It looks at the files on the computer. The simulation never touches files.',
  'os.path.isdir': 'It looks at the files on the computer. The simulation never touches files.',
  'os.listdir': 'It looks at the files on the computer. The simulation never touches files.',
  'os.makedirs': 'It makes a folder on the computer. The simulation never touches files.',
  input: 'It waits for someone to type. The simulation does not.',
  'time.time': 'It reads the clock, so the answer is different every time.',
  'time.perf_counter': 'It reads a stopwatch, so the answer is different every time.',
};

/** Library methods that change their receiver or argument in place. */
const IN_PLACE = new Set(['insert', 'update', 'pop', 'shuffle', 'heappush', 'heappop', 'heapify', 'sort', 'popitem', 'resize', 'fill', 'put', 'setdefault']);

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
  /** True when some setup line could not be computed, so a missing name may exist in reality. */
  partial: boolean;
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
  /** Built-in exception this class descends from, if any. */
  readonly excBase: string | null;
  /** Inherits from something not modelled, so unknown attributes may exist. */
  readonly open: boolean;
  /** Fields of a `@dataclass`, in order; null for ordinary classes. */
  readonly fields: ReadonlyArray<{ readonly name: string; readonly defaultValue: PyValue | null }> | null;
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
  readonly closure?: Closure;
  /** Names declared `global` / `nonlocal` here, with the scope they live in. */
  readonly outer?: Map<string, Map<string, Binding>>;
  /** The function's last statement is `raise`. */
  readonly endsInRaise?: boolean;
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
  readonly evidence?: 'simulated' | 'inferred' | 'unsupported';
  readonly assumption?: { key: string; taken: boolean } | null;
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
  /** Current contents of mutable containers, by reference id. */
  private readonly cells = new Map<number, PyValue>();
  private nextRef = 1;
  private mutated = false;
  /** > 0 while running setup code or the inside of a comprehension: no steps are recorded. */
  private quiet = 0;
  /** > 0 while an imported file's setup code runs. */
  private loading = 0;
  /** Loops being walked once because their collection or condition is `?`: what they changed. */
  private readonly guesses: Array<{ refs: Set<number>; fields: Array<readonly [number, string]> }> = [];
  private quietOps = 0;
  /** Decisions and loops on `?` met so far (recorded or not). */
  private unknownTurns = 0;
  private readonly excParents = new Map<string, string>();
  private handling: PyError | null = null;
  private lastReceiver: PyValue | null = null;
  private readonly choices: ReadonlyMap<string, boolean>;
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
    this.choices = options.choices ?? new Map();
    this.maxSteps = options.maxSteps ?? 5000;
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
        this.loadQuietly(mod);
        this.callEntryMethod(mod, this.entry);
      } else {
        this.loadQuietly(mod);
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
    if (err.recorded || this.quiet > 0) return;
    err.recorded = true;
    if (err instanceof PyError) {
      const message = `${err.pyType}: ${err.message}`;
      this.recordAt(mod, span, {
        kind: 'error',
        role: 'decision',
        title: err.pyType,
        what: `The simulated operation raises ${message}`,
        ...(this.unknownTurns > 0 ? { evidence: 'inferred' as const, notes: ['Earlier steps assumed the answer to questions that are not known, so the real program may not raise this.'] } : {}),
        why: 'Python raises this exception here. The run stops unless a surrounding `try` catches it.',
      });
    } else {
      this.recordAt(mod, span, {
        kind: 'unsupported',
        role: 'value',
        title: 'Not simulated',
        what: err.message,
        why: 'This statement is not modelled. Rather than guess, its effect is left out and the run continues.',
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
      partial: false,
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
      if (this.quiet === 0) this.execBlock(mod.ast.body, mod);
      else
        for (const stmt of mod.ast.body) {
          try {
            this.exec(stmt, mod);
          } catch (err) {
            if (!(err instanceof PyError || err instanceof UnsupportedError)) throw err;
            mod.partial = true;
            this.bindUnknown(stmt, mod);
          }
        }
    } finally {
      this.frames.pop();
    }
    mod.status = 'loaded';
  }

  /** Runs an imported file's setup code; big files load without a step per line. */
  private loadModule(mod: ModuleState) {
    if (mod.status !== 'new') return;
    if (this.entry.kind === 'script' && this.quiet === 0 && mod.ast.body.length <= QUIET_IMPORT_STATEMENTS) this.execModule(mod, false);
    else this.loadQuietly(mod);
  }

  private loadQuietly(mod: ModuleState) {
    if (mod.status !== 'new') return;
    this.loading++;
    try {
      this.silently(() => this.execModule(mod, false));
    } finally {
      this.loading--;
    }
    const first = mod.ast.body[0];
    if (first) this.skip(mod, first.span, `Setup code of ${mod.path} (${mod.ast.body.length} statements) ran without showing steps${mod.partial ? '; some of it could not be computed' : ''}`);
  }

  /**
   * Runs the inside of an expression (comprehension, sort key, …) without steps.
   * Null when the result cannot be trusted: it is too long, or it depended on a
   * decision that is not known. Whatever it changed on the way becomes `?`.
   */
  private inline<T>(run: () => T): T | null {
    if (this.quiet === 0) this.quietOps = 0;
    const turns = this.unknownTurns;
    const touched = { refs: new Set<number>(), fields: [] as Array<readonly [number, string]> };
    const depth = this.guesses.length;
    const taint = () => {
      this.guesses.length = depth;
      for (const ref of touched.refs) this.mutate({ t: 'list', items: [], ref }, unknown('changed on the way'));
      for (const [id, field] of touched.fields) this.heap.get(id)?.fields.set(field, { value: unknown('changed on the way'), setAt: null });
    };
    this.guesses.push(touched);
    try {
      const result = this.silently(run);
      if (this.unknownTurns > turns) {
        taint();
        return null;
      }
      return result;
    } catch (err) {
      const doubtful = err instanceof PyError && this.unknownTurns > turns;
      if (!doubtful && !(err instanceof TooLong && this.quiet === 0)) throw err;
      taint();
      return null;
    } finally {
      this.guesses.length = depth;
    }
  }

  private silently<T>(run: () => T): T {
    this.quiet++;
    const depth = this.frames.length;
    try {
      return run();
    } finally {
      this.quiet--;
      this.frames.length = Math.min(this.frames.length, depth);
    }
  }

  /** After a statement that could not be computed: the names it would set become `?`. */
  private bindUnknown(s: Stmt, mod: ModuleState) {
    const set = (name: string, span: Span) => this.bind(name, unknown(this.text(mod, span).slice(0, 60)), null);
    const target = (t: Expr) => {
      if (t.type === 'Name') set(t.id, t.span);
      else if (t.type === 'Tuple' || t.type === 'List') t.elts.forEach(target);
      else if (t.type === 'Starred') target(t.value);
    };
    switch (s.type) {
      case 'Assign':
        return s.targets.forEach(target);
      case 'AugAssign':
        return target(s.target);
      case 'FunctionDef':
      case 'ClassDef':
        return set(s.name, s.headerSpan);
      case 'Import':
      case 'ImportFrom':
        return s.names.forEach((x) => set(x.asname ?? x.name.split('.')[0]!, x.span));
      default:
        return;
    }
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
      // Projects nested in folders: try every parent folder of the importing file.
      for (let dir = dirname(fromPath); dir; dir = dirname(dir)) bases.push(dir);
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
  private resolve(raw: PyValue, depth = 2): PyValue {
    const value = this.fresh(raw);
    if (value.t === 'instance') {
      const obj = this.heap.get(value.id);
      if (!obj) return value;
      return { t: 'instance', id: value.id, cls: value.cls, fields: [...obj.fields.entries()].map(([k, b]) => [k, depth > 0 ? this.resolve(b.value, depth - 1) : b.value] as const) };
    }
    if (value.t === 'bound') return { ...value, self: this.resolve(value.self, depth) };
    return value;
  }

  /** The current contents of a mutable container (and of containers inside it). */
  private fresh(value: PyValue, depth = 5): PyValue {
    if (!('ref' in value) || value.ref === undefined) {
      return value.t === 'tuple' && this.mutated && depth > 0 ? { ...value, items: value.items.map((x) => this.fresh(x, depth - 1)) } : value;
    }
    const now = this.cells.get(value.ref) ?? value;
    if (!this.mutated || depth === 0) return now;
    if (now.t === 'list' || now.t === 'set') return { ...now, items: now.items.map((x) => this.fresh(x, depth - 1)) };
    if (now.t === 'dict') return { ...now, entries: now.entries.map(([k, x]) => [k, this.fresh(x, depth - 1)] as const) };
    return now;
  }

  /** Gives a new mutable container its identity, or returns its current contents. */
  private adopt(value: PyValue): PyValue {
    if (value.t !== 'list' && value.t !== 'dict' && value.t !== 'set' && value.t !== 'dataframe') return this.fresh(value);
    if (value.ref !== undefined) return this.fresh(value);
    const owned: PyValue = { ...value, ref: this.nextRef++ };
    this.cells.set(owned.ref!, owned);
    return owned;
  }

  /** Replaces the contents of a mutable container everywhere it is visible. */
  private mutate(container: PyValue, next: PyValue) {
    if (!('ref' in container) || container.ref === undefined) return;
    this.mutated = true;
    for (const touched of this.guesses) touched.refs.add(container.ref);
    this.cells.set(container.ref, next.t === 'unknown' ? next : ({ ...next, ref: container.ref } as PyValue));
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
    return this.quiet > 0 ? -1 : this.steps.length;
  }

  private recordAt(mod: ModuleState, span: Span, f: StepFields): number {
    if (this.quiet > 0) return -1;
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
      evidence: f.evidence ?? (this.guesses.length > 0 ? 'inferred' : 'simulated'),
      assumption: f.assumption ?? null,
    });
    return id;
  }

  private input(mod: ModuleState, expr: Expr | null, ev: Ev, role: StepInput['role'], label?: string, name?: string): StepInput {
    return {
      label: label ?? (expr ? this.text(mod, expr.span) : ''),
      value: ev.value,
      fromStep: ev.step !== null && ev.step >= 0 ? ev.step : null,
      fromVariable: ev.variable,
      role,
      ...(name !== undefined ? { name } : {}),
    };
  }

  private skip(mod: ModuleState, span: Span, reason: string) {
    if (this.quiet > 0) return;
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
      // A statement that is not modelled does not end the run: what it would set becomes `?`.
      if (err instanceof UnsupportedError && !(err instanceof MissingDataError)) {
        this.frame.module.partial = true;
        this.bindUnknown(s, mod);
        return;
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
        const targetName = s.target.type === 'Name' ? s.target.id : this.text(mod, s.target.span);
        const current = s.target.type === 'Name' ? this.lookup(s.target.id, s.target.span, mod) : this.eval(s.target, mod);
        const operand = this.eval(s.value, mod);
        const result = this.adopt(this.binary(s.op, current.value, operand.value));
        const id = this.nextId;
        // `xs += [...]` changes the list itself, so every name for it sees the change.
        if (s.op === '+' && current.value.t === 'list' && result.t === 'list') this.mutate(current.value, result);
        else this.bindTarget(s.target, result, id, mod);
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
          const { taken, assumption } = this.decide(test.value, branch.test.span, mod, branch.body);
          this.recordAt(mod, branch.span, {
            kind: 'decision',
            role: 'decision',
            title: assumption ? (taken ? 'Assumed yes → enter branch' : 'Assumed no → skip branch') : taken ? 'Condition true → enter branch' : 'Condition false → skip branch',
            inputs: [this.input(mod, branch.test, test, 'condition')],
            output: { t: 'bool', v: taken },
            target: { kind: 'branch', taken },
            assumption,
            ...(assumption ? { evidence: 'inferred' as const, notes: ['This condition depends on a value that is not known, so the direction is an assumption. You can switch it.'] } : {}),
            what: assumption
              ? `\`${this.text(mod, branch.test.span)}\` is not known here. The run assumes ${taken ? 'yes' : 'no'}.`
              : `\`${this.text(mod, branch.test.span)}\` is ${v(test.value)}, which counts as ${taken ? 'True' : 'False'}.`,
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
        // A collection that is not known is walked once, with `?` as the item.
        const guess = iterable.value.t === 'unknown';
        const items = guess ? [unknown(`an item of ${this.text(mod, s.iter.span)}`)] : iterate(iterable.value, this.maxIterations);
        if (items.length > this.maxIterations) throw new StopSignal('limit', `Loop has ${items.length} iterations; the simulation stops above ${this.maxIterations}.`);
        let i = 0;
        let broke = false;
        for (const raw of items) {
          i++;
          const item = this.adopt(raw);
          const id = this.nextId;
          const names = this.bindTarget(s.target, item, id, mod);
          this.recordAt(mod, s.headerSpan, {
            kind: 'loop',
            role: 'loop',
            title: guess ? 'One example item' : `Iteration ${i} of ${items.length}`,
            ...(guess ? { evidence: 'inferred' as const, notes: ['The collection is not known, so its block is walked once with `?` as the item.'] } : {}),
            inputs: [this.input(mod, s.iter, iterable, 'iterable')],
            output: item,
            selectedIndex: i - 1,
            target: { kind: 'variable', names, frameId: this.frame.id },
            what: guess ? `\`${this.text(mod, s.iter.span)}\` is not known here. The block is walked once; \`${names.join(', ')}\` is \`?\`.` : `Takes item ${i} of ${items.length} from \`${this.text(mod, s.iter.span)}\`: ${v(item)} goes into \`${names.join(', ')}\`.`,
            why: 'A `for` loop runs its block once per item, in order.',
          });
          try {
            if (guess) this.guessOnce(s, mod, () => this.execBlock(s.body, mod));
            else this.execBlock(s.body, mod);
          } catch (signal) {
            if (signal instanceof BreakSignal) {
              broke = true;
              break;
            }
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
          ...(guess ? { evidence: 'inferred' as const } : {}),
          what: guess
            ? `The loop over \`${this.text(mod, s.iter.span)}\` is left. How many items it really has is not known, so everything it changed is \`?\` from here on.`
            : `The loop over \`${this.text(mod, s.iter.span)}\` is done after ${i} iteration${i === 1 ? '' : 's'}.`,
          why: 'Execution continues with the first statement after the loop.',
        });
        if (!broke) this.execBlock(s.orelse, mod);
        return;
      }
      case 'While': {
        let count = 0;
        let guess = false;
        for (;;) {
          if (guess) {
            this.recordAt(mod, s.headerSpan, { kind: 'loop', role: 'loop', title: 'Loop finished', target: { kind: 'next' }, evidence: 'inferred', what: 'The loop is left. How often it really repeats is not known, so everything it changed is `?` from here on.', why: 'Execution continues with the first statement after the loop.' });
            return;
          }
          const test = this.eval(s.test, mod);
          // A condition that is not known lets the block run once.
          guess = test.value.t === 'unknown';
          const taken = test.value.t === 'unknown' || truthy(test.value);
          this.recordAt(mod, s.headerSpan, {
            kind: 'decision',
            role: 'loop',
            ...(guess ? { evidence: 'inferred' as const, notes: ['The condition is not known, so the block is walked once.'] } : {}),
            title: taken ? 'Loop condition true → repeat' : 'Loop condition false → exit',
            inputs: [this.input(mod, s.test, test, 'condition')],
            output: { t: 'bool', v: taken },
            target: { kind: 'branch', taken },
            what: `\`${this.text(mod, s.test.span)}\` is ${v(test.value)}.`,
            why: taken ? 'The loop body runs again.' : 'The loop ends.',
          });
          if (!taken) {
            this.execBlock(s.orelse, mod);
            return;
          }
          if (++count > this.maxIterations) throw new StopSignal('limit', `Stopped after ${this.maxIterations} loop iterations.`);
          try {
            if (guess) this.guessOnce(s, mod, () => this.execBlock(s.body, mod));
            else this.execBlock(s.body, mod);
          } catch (signal) {
            if (signal instanceof BreakSignal) return;
            if (signal instanceof ContinueSignal) continue;
            throw signal;
          }
        }
      }
      case 'FunctionDef': {
        const opaque = s.decorators.find((d) => !TRANSPARENT_DECORATORS.test(this.text(mod, d.span)));
        if (opaque) throw new UnsupportedError(`The decorator \`@${this.text(mod, opaque.span)}\` may change this function, so calls to \`${s.name}\` are not computed. You can still run the function itself.`, s.headerSpan);
        const qualname = this.frame.kind === 'function' ? `${this.frame.name}.<locals>.${s.name}` : s.name;
        const fn: FunctionValue = { def: s, path: mod.path, qualname, ...this.closureHere() };
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
      case 'Declare':
        this.skip(mod, s.span, 'A type note without a value does nothing when run');
        return;
      case 'Scope': {
        const outer = this.frame.outer;
        for (const name of s.names) outer?.set(name, this.frame.closure?.find((c) => c.has(name)) ?? this.frame.module.globals);
        return;
      }
      case 'With':
        return this.withBlock(s, mod);
      case 'Try':
        return this.tryBlock(s, mod);
      case 'Raise': {
        if (!s.exc) {
          if (this.handling) {
            const again = this.handling;
            throw new PyError(again.pyType, again.message);
          }
          throw new PyError('RuntimeError', 'No active exception to reraise');
        }
        const exc = this.eval(s.exc, mod).value;
        if (exc.t === 'exception') throw new PyError(exc.name, exc.message);
        if (exc.t === 'exc-type') throw new PyError(exc.name, '');
        if (exc.t === 'class') throw new PyError(exc.name, '');
        throw new PyError(this.text(mod, s.exc.span).split('(')[0]!, 'raised here');
      }
      case 'Assert': {
        const test = this.eval(s.test, mod);
        const { taken, assumption } = test.value.t === 'unknown' ? { taken: true, assumption: { key: overrideKey(mod.path, s.test.span), taken: true } } : { taken: truthy(test.value), assumption: null };
        if (assumption) {
          this.unknownTurns++;
          this.assume(`${mod.path}, line ${positionAt(mod.lineStarts, s.span.from).line}: the check \`${this.text(mod, s.test.span).replace(/\s+/g, ' ')}\` is not known. The run assumes it passes.`);
        }
        this.recordAt(mod, s.span, {
          kind: 'decision',
          role: 'decision',
          title: 'Check (assert)',
          inputs: [this.input(mod, s.test, test, 'condition')],
          output: { t: 'bool', v: taken },
          target: { kind: 'branch', taken },
          ...(assumption ? { evidence: 'inferred' as const, notes: ['The checked value is not known; the run assumes the check passes.'] } : {}),
          what: assumption ? `Checks \`${this.text(mod, s.test.span)}\`, which is not known here. The run assumes it passes.` : `Checks \`${this.text(mod, s.test.span)}\`: ${taken ? 'passes' : 'fails'}.`,
          why: '`assert` stops the program when its condition is false.',
        });
        if (!taken) {
          const message = s.message ? this.eval(s.message, mod).value : null;
          throw new PyError('AssertionError', message ? pyStrOf(message) : '');
        }
        return;
      }
      case 'Delete': {
        for (const t of s.targets) {
          if (t.type === 'Name') this.frame.locals.delete(t.id);
          else if (t.type === 'Subscript') {
            const base = this.eval(t.value, mod).value;
            const key = t.index.type === 'Slice' ? unknown('slice') : this.eval(t.index, mod).value;
            const at = base.t === 'list' ? numericOf(key) : null;
            if (base.t === 'dict' && key.t !== 'unknown') {
              if (!base.entries.some(([k]) => pyEquals(k, key))) throw new PyError('KeyError', pyRepr(key));
              this.mutate(base, { ...base, entries: base.entries.filter(([k]) => !pyEquals(k, key)) });
            } else if (base.t === 'list' && at !== null) {
              const i = at < 0 ? at + base.items.length : at;
              if (i < 0 || i >= base.items.length) throw new PyError('IndexError', 'list assignment index out of range');
              this.mutate(base, { ...base, items: base.items.filter((_, n) => n !== i) });
            }
            else this.mutate(base, unknown(this.text(mod, t.span)));
          }
        }
        this.recordAt(mod, s.span, { kind: 'operation', role: 'variable', title: 'Delete', target: { kind: 'next' }, what: `Removes \`${s.targets.map((t) => this.text(mod, t.span)).join('`, `')}\`.`, why: '`del` removes a name or an item.' });
        return;
      }
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
    if (target.type === 'Starred') return this.bindTarget(target.value, value, stepId, mod);
    if ((target.type === 'Tuple' || target.type === 'List') && value.t === 'unknown') {
      return target.elts.flatMap((t) => this.bindTarget(t, unknown(`part of ${value.from}`), stepId, mod));
    }
    if (target.type === 'Tuple' || target.type === 'List') {
      const items = iterate(value, this.maxIterations);
      const star = target.elts.findIndex((t) => t.type === 'Starred');
      if (star >= 0) {
        const after = target.elts.length - star - 1;
        if (items.length < target.elts.length - 1) throw new PyError('ValueError', `not enough values to unpack (expected at least ${target.elts.length - 1}, got ${items.length})`);
        const middle = this.adopt({ t: 'list', items: items.slice(star, items.length - after) });
        const parts = [...items.slice(0, star), middle, ...items.slice(items.length - after)];
        return target.elts.flatMap((t, i) => this.bindTarget(t, parts[i]!, stepId, mod));
      }
      if (items.length !== target.elts.length) {
        throw new PyError('ValueError', items.length > target.elts.length ? `too many values to unpack (expected ${target.elts.length})` : `not enough values to unpack (expected ${target.elts.length}, got ${items.length})`);
      }
      return target.elts.flatMap((t, i) => this.bindTarget(t, items[i]!, stepId, mod));
    }
    if (target.type === 'Attribute') {
      const base = this.eval(target.value, mod).value;
      if (base.t === 'unknown') return [this.text(mod, target.span)];
      if (base.t !== 'instance') throw new UnsupportedError(`Setting \`.${target.attr}\` on ${typeName(base)} is not modelled.`, target.span);
      for (const touched of this.guesses) touched.fields.push([base.id, target.attr]);
      this.heap.get(base.id)!.fields.set(target.attr, { value, setAt: stepId >= 0 ? stepId : null });
      return [this.text(mod, target.span)];
    }
    if (target.type === 'Subscript') {
      const base = this.eval(target.value, mod).value;
      const label = this.text(mod, target.span);
      if (base.t === 'unknown') return [label];
      const key = target.index.type === 'Slice' ? unknown('slice') : this.eval(target.index, mod).value;
      this.mutate(base, this.withItem(base, key, value, label));
      return [label];
    }
    throw new UnsupportedError('This assignment target is not modelled.', target.span);
  }

  private bind(name: string, value: PyValue, setAt: number | null) {
    const scope = this.frame.outer?.get(name) ?? this.frame.locals;
    scope.set(name, { value, setAt: setAt !== null && setAt >= 0 ? setAt : null });
  }

  /** `container[key] = value` for the modelled containers; anything else makes the container `?`. */
  private withItem(base: PyValue, key: PyValue, value: PyValue, label: string): PyValue {
    if (key.t === 'unknown') return unknown(label);
    if (base.t === 'dict') return dictSet(base, key, value);
    if (base.t === 'list') {
      const n = numericOf(key);
      if (n === null) throw new PyError('TypeError', `list indices must be integers or slices, not ${typeName(key)}`);
      const at = n < 0 ? n + base.items.length : n;
      if (at < 0 || at >= base.items.length) throw new PyError('IndexError', 'list assignment index out of range');
      return { ...base, items: base.items.map((x, i) => (i === at ? value : x)) };
    }
    if (base.t === 'dataframe' && key.t === 'str') {
      if (value.t === 'unknown') return unknown(label);
      try {
        return setColumn(base, key.v, value);
      } catch (err) {
        if (err instanceof UnsupportedError) return unknown(label);
        throw err;
      }
    }
    if (base.t === 'tuple' || base.t === 'str') throw new PyError('TypeError', `'${typeName(base)}' object does not support item assignment`);
    throw new UnsupportedError(`Setting an item of ${typeName(base)} is not modelled.`);
  }

  private closureHere(): { closure?: Closure } {
    if (this.frame.kind !== 'function') return {};
    return { closure: [this.frame.locals, ...(this.frame.closure ?? [])] };
  }

  /** Which way a condition goes. On `?` the run assumes a direction that the user can switch. */
  private decide(value: PyValue, span: Span, mod: ModuleState, body: readonly Stmt[]): { taken: boolean; assumption: { key: string; taken: boolean } | null } {
    if (value.t !== 'unknown') return { taken: truthy(value), assumption: null };
    this.unknownTurns++;
    const key = overrideKey(mod.path, span);
    // Blocks that only bail out (raise, return, continue) are usually exceptional, so assume "no" for them.
    // (A chain of `if …: return` that ends in `raise` is the other way round: one of them is expected to match.)
    const last = body[body.length - 1]?.type;
    const bailsOut = body.length <= 2 && (last === 'Raise' || last === 'Continue' || last === 'Break' || (last === 'Return' && !this.frame.endsInRaise));
    const taken = this.choices.get(key) ?? !bailsOut;
    this.assume(`${mod.path}, line ${positionAt(mod.lineStarts, span.from).line}: \`${this.text(mod, span).replace(/\s+/g, ' ')}\` is not known. The run assumes ${taken ? 'yes' : 'no'}.`);
    return { taken, assumption: { key, taken } };
  }

  /**
   * Runs a loop body once as an example. Afterwards everything the body changed
   * becomes `?`, because the real number of repetitions is not known.
   */
  private guessOnce(loop: Extract<Stmt, { type: 'For' | 'While' }>, mod: ModuleState, run: () => void) {
    const line = positionAt(mod.lineStarts, loop.span.from).line;
    this.unknownTurns++;
    this.assume(`${mod.path}, line ${line}: how often this loop repeats is not known. Its block is shown once, as an example.`);
    const touched = { refs: new Set<number>(), fields: [] as Array<readonly [number, string]> };
    const frame = this.frame;
    this.guesses.push(touched);
    try {
      run();
    } finally {
      this.guesses.splice(this.guesses.indexOf(touched), 1);
      const why = `changed by the loop in line ${line}`;
      const header: Stmt[] = loop.type === 'For' ? [{ type: 'Assign', targets: [loop.target], value: loop.iter, span: loop.span }] : [];
      for (const name of assignedNames([...header, ...loop.body])) (frame.outer?.get(name) ?? frame.locals).set(name, { value: unknown(why), setAt: null });
      for (const ref of touched.refs) this.mutate({ t: 'list', items: [], ref }, unknown(why));
      for (const [id, field] of touched.fields) this.heap.get(id)?.fields.set(field, { value: unknown(why), setAt: null });
    }
  }

  /** Adds an assumption once. */
  private assume(text: string) {
    if ((this.quiet === 0 || this.loading > 0) && !this.assumptions.includes(text)) this.assumptions.push(text);
  }

  private withBlock(s: Extract<Stmt, { type: 'With' }>, mod: ModuleState) {
    const exits: Array<() => void> = [];
    for (const item of s.items) {
      const ctx = this.eval(item.context, mod);
      let bound: PyValue = unknown(this.text(mod, item.context.span));
      if (ctx.value.t === 'instance') {
        const self = ctx.value;
        const cls = this.objectClass(self);
        const enter = this.lookupMember(cls, '__enter__');
        const exit = this.lookupMember(cls, '__exit__');
        const selfInput: StepInput = { label: this.text(mod, item.context.span), value: self, fromStep: ctx.step !== null && ctx.step >= 0 ? ctx.step : null, fromVariable: ctx.variable, role: 'receiver', name: 'self' };
        if (enter?.kind === 'method') bound = this.callUser(enter.fn, [self], new Map(), [selfInput], item.context.span, mod, `${cls.name}.__enter__`).value;
        if (exit?.kind === 'method') exits.push(() => void this.callUser(exit.fn, [self, NONE, NONE, NONE], new Map(), [selfInput], item.context.span, mod, `${cls.name}.__exit__`));
      }
      const id = this.nextId;
      const names = item.target ? this.bindTarget(item.target, bound, id, mod) : [];
      this.recordAt(mod, s.headerSpan, {
        kind: 'assign',
        role: 'variable',
        title: 'Open (with)',
        inputs: [this.input(mod, item.context, ctx, 'value')],
        output: bound,
        target: names.length ? { kind: 'variable', names, frameId: this.frame.id } : { kind: 'next' },
        what: `Opens \`${this.text(mod, item.context.span)}\`${names.length ? ` as \`${names.join(', ')}\`` : ''} for the block below.`,
        why: '`with` prepares something for a block and tidies up afterwards.',
      });
    }
    this.execBlock(s.body, mod);
    for (const exit of exits.reverse()) exit();
  }

  private isKindOf(name: string, family: string): boolean {
    for (let n: string | undefined = name, i = 0; n && i < 30; i++) {
      if (n === family) return true;
      n = this.excParents.get(n) ?? EXCEPTIONS[n];
    }
    return false;
  }

  private tryBlock(s: Extract<Stmt, { type: 'Try' }>, mod: ModuleState) {
    const depth = this.frames.length;
    const callDepth = this.calls.length;
    try {
      let failed: PyError | null = null;
      try {
        this.execBlock(s.body, mod);
      } catch (err) {
        if (!(err instanceof PyError)) throw err;
        failed = err;
      }
      if (!failed) {
        this.execBlock(s.orelse, mod);
        return;
      }
      this.frames.length = depth;
      this.calls.length = callDepth;
      const handler = s.handlers.find((h) => {
        if (!h.exc) return true;
        const kinds = this.silently(() => this.eval(h.exc!, mod).value);
        const options = kinds.t === 'tuple' ? kinds.items : [kinds];
        return options.some((k) => (k.t === 'exc-type' || k.t === 'class') && this.isKindOf(failed!.pyType, k.name));
      });
      if (!handler) throw failed;
      if (handler.name) this.bind(handler.name, { t: 'exception', name: failed.pyType, message: failed.message }, null);
      this.recordAt(mod, handler.span, {
        kind: 'decision',
        role: 'decision',
        title: `Caught ${failed.pyType}`,
        target: { kind: 'branch', taken: true },
        what: `The ${failed.pyType} raised above is caught here, so the program continues in this block.`,
        why: '`except` handles an error instead of letting it stop the program.',
      });
      const before = this.handling;
      this.handling = failed;
      try {
        this.execBlock(handler.body, mod);
      } finally {
        this.handling = before;
      }
    } finally {
      if (s.finalbody.length > 0) this.execBlock(s.finalbody, mod);
    }
  }

  // ---- Imports ---------------------------------------------------------------

  private importName(name: string, asname: string | null, span: Span, mod: ModuleState) {
    const path = this.resolveModule(name, 0, mod.path);
    const bindAs = asname ?? name.split('.')[0]!;
    if (path) {
      if (name.includes('.') && !asname) throw new UnsupportedError('Project imports like `import a.b` (without `as`) are not modelled.', span);
      const target = this.moduleFor(path)!;
      const loading = target.status === 'new';
      if (loading) this.recordImportStart(mod, span, name, path);
      this.loadModule(target);
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
        : `\`${name}\` is not in this project and is not modelled. Results from it show as \`?\`.`,
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
    if (moduleLabel === '__future__') {
      this.skip(mod, s.span, 'This only changes how Python reads the file; it does nothing when run');
      return;
    }
    const path = this.resolveModule(s.module, s.level, mod.path);
    if (path) {
      const target = this.moduleFor(path)!;
      if (target.status === 'new') this.recordImportStart(mod, s.span, moduleLabel, path);
      this.loadModule(target);
      const names: string[] = [];
      const values: PyValue[] = [];
      const id = this.nextId;
      for (const n of s.names) {
        if (n.name === '*') {
          for (const [name, b] of target.globals) if (!name.startsWith('_')) this.bind(name, b.value, id);
          if (target.partial) mod.partial = true;
          continue;
        }
        let binding = target.globals.get(n.name);
        if (!binding) {
          const sub = this.resolveModule(n.name, 1, path);
          if (sub) {
            this.loadModule(this.moduleFor(sub)!);
            binding = { value: { t: 'module', name: n.name, origin: 'project', modelled: true, path: sub }, setAt: null };
          }
        }
        if (!binding && target.partial) binding = { value: unknown(`${moduleLabel}.${n.name}`), setAt: null };
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
    // Packages without an `__init__.py`: the imported names may be files inside the folder.
    const inside = s.names.map((n) => this.resolveModule([s.module, n.name].filter(Boolean).join('.'), s.level, mod.path));
    if (inside.some(Boolean)) {
      const names: string[] = [];
      const id = this.nextId;
      s.names.forEach((n, i) => {
        const sub = inside[i];
        if (!sub) throw new PyError('ImportError', `cannot import name '${n.name}' from '${moduleLabel}'`);
        this.loadModule(this.moduleFor(sub)!);
        this.bind(n.asname ?? n.name, { t: 'module', name: n.name, origin: 'project', modelled: true, path: sub }, id);
        names.push(n.asname ?? n.name);
      });
      this.recordAt(mod, s.span, {
        kind: 'import',
        role: 'function',
        title: 'Import names',
        target: { kind: 'variable', names, frameId: this.frame.id },
        what: `\`${names.join('`, `')}\` now refer${names.length === 1 ? 's' : ''} to ${inside.join(', ')}.`,
        why: 'Importing runs a file once and gives this file a name to reach its contents.',
      });
      return;
    }
    const root = (s.module ?? '').split('.')[0]!;
    if (s.level > 0) throw new PyError('ImportError', `attempted relative import '${moduleLabel}' could not be resolved in this project`);
    const modelled = root in MODELLED_LIBRARIES;
    const names: string[] = [];
    const id = this.nextId;
    // `from library import *` may bring in any name, so unknown names show as `?` from here on.
    if (s.names.length === 0 || s.names.some((n) => n.name === '*')) mod.partial = true;
    for (const n of s.names) {
      if (n.name === '*') continue;
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
      why: modelled ? 'Supported operations of this library are modelled in JavaScript.' : 'This library is not modelled; results from these names show as `?`.',
    });
  }

  // ---- Expressions -------------------------------------------------------------

  private lookup(name: string, span: Span, mod: ModuleState): Ev {
    const local = this.frame.outer?.get(name)?.get(name) ?? this.frame.locals.get(name);
    if (local) return { value: local.value, step: local.setAt, variable: name };
    for (const scope of this.frame.closure ?? []) {
      const captured = scope.get(name);
      if (captured) return { value: captured.value, step: captured.setAt, variable: null };
    }
    const global = this.frame.module.globals.get(name);
    if (global) return { value: global.value, step: global.setAt, variable: name };
    if (BUILTINS.has(name)) return { value: { t: 'builtin', name }, step: null, variable: null };
    if (name in EXCEPTIONS) return { value: { t: 'exc-type', name }, step: null, variable: null };
    if (UNMODELLED_BUILTINS.has(name) || this.frame.module.partial) return { value: unknown(name), step: null, variable: null };
    void mod;
    void span;
    throw new PyError('NameError', `name '${name}' is not defined`);
  }

  private eval(e: Expr, mod: ModuleState): Ev {
    if (this.quiet > 0 && ++this.quietOps > (this.loading > 0 ? MAX_QUIET_OPS : MAX_INLINE_OPS)) {
      if (this.loading > 0) throw new StopSignal('limit', 'Stopped: the setup code is too long to simulate.');
      throw new TooLong();
    }
    try {
      const ev = this.evalInner(e, mod);
      return { ...ev, value: this.adopt(ev.value) };
    } catch (err) {
      // Not modelled: the result is `?` and the run continues.
      if (err instanceof UnsupportedError && !(err instanceof MissingDataError)) return this.notComputed(e, mod, err.message, []);
      if ((err instanceof PyError || err instanceof UnsupportedError) && !err.recorded) {
        err.span ??= e.span;
        this.recordFailure(err, mod, err.span);
      }
      throw err;
    }
  }

  /** Records that something could not be computed; its result is `?`. */
  private notComputed(e: Expr, mod: ModuleState, reason: string, inputs: StepInput[]): Ev {
    const code = this.text(mod, e.span).replace(/\s+/g, ' ');
    const value = unknown(code.length > 60 ? `${code.slice(0, 59)}…` : code);
    const callee = e.type === 'Call' ? this.text(mod, e.func.span) : code;
    const phrase = describeLibrary(this.libraryPath(e, mod) ?? callee);
    const step = this.recordAt(mod, e.span, {
      kind: 'unknown',
      role: 'value',
      title: 'Not computed',
      inputs,
      output: value,
      target: { kind: 'next' },
      what: `${phrase ? `${phrase} ` : ''}The result of \`${code.length > 70 ? `${code.slice(0, 69)}…` : code}\` is not computed here, so it shows as \`?\`.`,
      why: reason,
      evidence: 'unsupported',
    });
    return { value, step, variable: null };
  }

  /** Full dotted library name of a call, e.g. `stats.norm.ppf(…)` → `scipy.stats.norm.ppf`. */
  private libraryPath(e: Expr, mod: ModuleState): string | null {
    if (e.type !== 'Call') return null;
    const parts: string[] = [];
    let node: Expr = e.func;
    while (node.type === 'Attribute') {
      parts.unshift(node.attr);
      node = node.value;
    }
    if (node.type === 'Name') {
      const root = this.frame.locals.get(node.id)?.value ?? this.frame.module.globals.get(node.id)?.value;
      if (root?.t === 'module' && root.origin === 'library') return [root.name, ...parts].join('.');
      if (root?.t === 'unknown') return [root.from, ...parts].join('.');
    }
    void mod;
    return parts.length > 0 ? `.${parts[parts.length - 1]}` : null;
  }

  /** Python operators, with `?` in → `?` out. */
  private binary(op: string, a: PyValue, b: PyValue): PyValue {
    if (a.t === 'unknown' || b.t === 'unknown') return unknown(op);
    for (const x of [a, b]) if (['instance', 'dataframe', 'function', 'bound', 'method', 'module', 'class', 'iloc', 'builtin'].includes(x.t)) throw new UnsupportedError(`\`${op}\` with ${typeName(x)} is not modelled.`);
    const arrays = [a, b].some((x) => x.t === 'series' || x.t === 'ndarray');
    if (arrays && ['&', '|', '^'].includes(op)) return logicArrays(op, a, b);
    return binaryOp(op, a, b);
  }

  private compare(op: string, a: PyValue, b: PyValue): PyValue {
    if (a.t === 'unknown' || b.t === 'unknown') return unknown(op);
    const arrays = [a, b].some((x) => x.t === 'series' || x.t === 'ndarray');
    if (op === 'is' || op === 'is not') {
      if (a.t !== 'none' && b.t !== 'none' && a.t !== 'bool' && b.t !== 'bool') throw new UnsupportedError('`is` is only modelled for None, True and False.');
      return { t: 'bool', v: compareOp(op, a, b) };
    }
    if (op === 'in' || op === 'not in') {
      if (hasUnknown(a) || hasUnknown(b)) return unknown(op);
      return { t: 'bool', v: compareOp(op, a, b) };
    }
    if (arrays) return compareArrays(op, a, b);
    for (const x of [a, b]) if (['dataframe', 'function', 'bound', 'method', 'module', 'iloc'].includes(x.t) || (x.t === 'instance' && op !== '==' && op !== '!=')) throw new UnsupportedError(`\`${op}\` with ${typeName(x)} is not modelled.`);
    if (hasUnknown(a) || hasUnknown(b)) return unknown(op);
    return { t: 'bool', v: compareOp(op, a, b) };
  }

  /** Calls a function value without showing its inner steps (sort keys, map, filter, lambdas). */
  private invoke(fn: PyValue, args: readonly PyValue[], mod: ModuleState, span: Span): PyValue {
    const result = this.inline((): PyValue => {
      switch (fn.t) {
        case 'function':
          return this.adopt(this.callUser(fn.fn, args, new Map(), [], span, mod, fn.fn.qualname).value);
        case 'bound':
          return this.adopt(this.callUser(fn.fn, [fn.self, ...args], new Map(), [], span, mod, fn.fn.qualname).value);
        case 'builtin':
          if (fn.name.includes('.')) return callLibraryFunction(fn.name, args, new Map());
          return this.callBuiltin(fn.name, args, new Map(), [], { type: 'Call', func: { type: 'Name', id: fn.name, span }, args: [], keywords: [], span }, mod).value;
        case 'method': {
          if (hasContainerMethod(fn.self, fn.name)) return callContainerMethod(this.fresh(fn.self), fn.name, args, new Map()).result;
          return callMethod(fn, args, new Map());
        }
        default:
          throw new UnsupportedError('Calling this value is not modelled.');
      }
    });
    return result ?? unknown('a result');
  }

  private comprehension(e: Extract<Expr, { type: 'Comprehension' }>, mod: ModuleState): Ev {
    const first = this.eval(e.generators[0]!.iter, mod);
    const saved = new Map<string, Binding | undefined>();
    const remember = (t: Expr): void => {
      if (t.type === 'Name') saved.set(t.id, this.frame.locals.get(t.id));
      else if (t.type === 'Tuple' || t.type === 'List') t.elts.forEach(remember);
      else if (t.type === 'Starred') remember(t.value);
    };
    e.generators.forEach((g) => remember(g.target));
    const out: PyValue[] = [];
    const pairs: Array<[PyValue, PyValue]> = [];
    let open = first.value.t === 'unknown';
    const walk = (i: number): void => {
      if (open) return;
      const g = e.generators[i];
      if (!g) {
        if (out.length + pairs.length > this.maxIterations * 4) throw new UnsupportedError('This comprehension is too long to simulate.');
        if (e.kind === 'dict') {
          const key = this.eval(e.elt, mod).value;
          if (hasUnknown(key)) open = true;
          pairs.push([key, e.value ? this.eval(e.value, mod).value : NONE]);
        } else out.push(this.eval(e.elt, mod).value);
        return;
      }
      const source = i === 0 ? first.value : this.eval(g.iter, mod).value;
      if (source.t === 'unknown') {
        open = true;
        return;
      }
      for (const item of iterate(source, this.maxIterations * 4)) {
        this.bindTarget(g.target, this.fresh(item), -1, mod);
        let keep = true;
        for (const cond of g.ifs) {
          const c = this.eval(cond, mod).value;
          if (c.t === 'unknown') {
            open = true;
            return;
          }
          if (!truthy(c)) {
            keep = false;
            break;
          }
        }
        if (keep) walk(i + 1);
        if (open) return;
      }
    };
    try {
      if (this.inline(() => walk(0) ?? true) === null) open = true;
    } finally {
      for (const [name, old] of saved) {
        if (old) this.frame.locals.set(name, old);
        else this.frame.locals.delete(name);
      }
    }
    const names = { list: 'list', set: 'set', dict: 'dictionary', generator: 'list' } as const;
    // A generator's items are only made when asked for; `?` items would hide that, lists of values do not.
    const value: PyValue = open
      ? unknown(this.text(mod, e.span).slice(0, 60))
      : e.kind === 'dict'
        ? pairs.reduce<Extract<PyValue, { t: 'dict' }>>((d, [k, x]) => dictSet(d, k, x), { t: 'dict', entries: [] })
        : e.kind === 'set'
          ? hasUnknown({ t: 'list', items: out }) ? unknown(this.text(mod, e.span).slice(0, 60)) : { t: 'set', items: uniqueItems(out) }
          : { t: 'list', items: out };
    const step = this.recordAt(mod, e.span, {
      kind: 'operation',
      role: 'collection',
      title: `Build ${names[e.kind]}`,
      inputs: [this.input(mod, e.generators[0]!.iter, first, 'iterable')],
      output: this.adopt(value),
      target: { kind: 'next' },
      what: open ? `Builds a ${names[e.kind]} from \`${this.text(mod, e.generators[0]!.iter.span)}\`, which is not fully known, so the result is \`?\`.` : `Goes through \`${this.text(mod, e.generators[0]!.iter.span)}\` and builds a ${names[e.kind]}: ${v(value)}.`,
      why: `A comprehension makes a new ${names[e.kind]} by computing \`${this.text(mod, e.elt.span)}\` for each item.`,
    });
    return { value, step, variable: null };
  }

  private formatText(parts: ReadonlyArray<string | FormatPart>, mod: ModuleState, inputs: StepInput[]): string | null {
    let out = '';
    let known = true;
    for (const part of parts) {
      if (typeof part === 'string') {
        out += part;
        continue;
      }
      const ev = this.eval(part.value, mod);
      inputs.push(this.input(mod, part.value, ev, 'value'));
      const spec = part.spec ? this.formatText(part.spec, mod, []) : '';
      if (hasUnknown(ev.value) || spec === null) {
        known = false;
        continue;
      }
      const shown = part.selfDoc !== null && !part.conversion && !spec ? { t: 'str' as const, v: pyRepr(ev.value) } : convert(ev.value, part.conversion);
      out += (part.selfDoc ?? '') + formatValue(shown, spec);
    }
    return known ? out : null;
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
      case 'Set':
      case 'Tuple': {
        const items: PyValue[] = [];
        for (const x of e.elts) {
          if (x.type !== 'Starred') items.push(this.eval(x, mod).value);
          else {
            const spread = this.eval(x.value, mod).value;
            if (spread.t === 'unknown') return { value: unknown(this.text(mod, e.span).slice(0, 60)), step: null, variable: null };
            items.push(...iterate(spread, this.maxIterations * 4));
          }
        }
        if (e.type === 'Set') {
          if (items.some((x) => hasUnknown(x))) return { value: unknown(this.text(mod, e.span).slice(0, 60)), step: null, variable: null };
          return { value: { t: 'set', items: uniqueItems(items) }, step: null, variable: null };
        }
        return { value: { t: e.type === 'List' ? 'list' : 'tuple', items }, step: null, variable: null };
      }
      case 'JoinedStr': {
        const inputs: StepInput[] = [];
        const text = this.formatText(e.parts, mod, inputs);
        const value: PyValue = text === null ? unknown(this.text(mod, e.span).slice(0, 60)) : { t: 'str', v: text };
        const step = this.recordAt(mod, e.span, {
          kind: 'operation',
          role: 'value',
          title: 'Build text',
          inputs,
          output: value,
          target: { kind: 'next' },
          what: text === null ? 'Builds a text from values, but some of them are not known.' : `Builds the text ${v(value)}.`,
          why: 'An f-string puts values into a text.',
        });
        return { value, step, variable: null };
      }
      case 'Comprehension':
        return this.comprehension(e, mod);
      case 'Lambda': {
        const def: FunctionDef = { type: 'FunctionDef', name: '<lambda>', params: e.params, body: [{ type: 'Return', value: e.body, span: e.body.span }], decorators: [], isAsync: false, headerSpan: e.span, span: e.span };
        return { value: { t: 'function', fn: { def, path: mod.path, qualname: '<lambda>', ...this.closureHere() } }, step: null, variable: null };
      }
      case 'NamedExpr': {
        const ev = this.eval(e.value, mod);
        const id = this.nextId;
        this.bind(e.name, ev.value, id);
        const step = this.recordAt(mod, e.span, { kind: 'assign', role: 'variable', title: 'Store in variable', inputs: [this.input(mod, e.value, ev, 'value')], output: ev.value, target: { kind: 'variable', names: [e.name], frameId: this.frame.id }, what: `Stores ${v(ev.value)} in \`${e.name}\`.`, why: '`:=` stores a value and uses it at the same time.' });
        return { value: ev.value, step, variable: null };
      }
      case 'Ellipsis':
        return { value: { t: 'ellipsis' }, step: null, variable: null };
      case 'Starred':
      case 'Slice':
        throw new UnsupportedError('This form is not modelled here.', e.span);
      case 'Yield': {
        const ev: Ev = e.value ? this.eval(e.value, mod) : { value: NONE, step: null, variable: null };
        const step = this.recordAt(mod, e.span, { kind: 'return', role: 'return', title: 'Hand out (yield)', inputs: e.value ? [this.input(mod, e.value, ev, 'value')] : [], output: ev.value, target: { kind: 'next' }, what: `Hands out ${v(ev.value)} and waits until the next one is asked for.`, why: 'A function with `yield` gives its values one at a time.' });
        return { value: unknown('what the caller sends in'), step, variable: null };
      }
      case 'Await':
        throw new UnsupportedError('`await` is not modelled.', e.span);
      case 'Dict': {
        let dict: Extract<PyValue, { t: 'dict' }> = { t: 'dict', entries: [] };
        let open = false;
        e.keys.forEach((k, i) => {
          const value = this.eval(e.values[i]!, mod).value;
          if (k === null) {
            if (value.t === 'dict') for (const [k2, v2] of value.entries) dict = dictSet(dict, k2, v2);
            else open = true;
            return;
          }
          const key = this.eval(k, mod).value;
          if (hasUnknown(key)) open = true;
          else dict = dictSet(dict, key, value);
        });
        return { value: open ? unknown(this.text(mod, e.span).slice(0, 60)) : dict, step: null, variable: null };
      }
      case 'BinOp': {
        const left = this.eval(e.left, mod);
        const right = this.eval(e.right, mod);
        const result = this.binary(e.op, left.value, right.value);
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
        if (left.value.t === 'unknown') {
          const right = this.eval(e.right, mod);
          const value = unknown(this.text(mod, e.span).slice(0, 60));
          const step = this.recordAt(mod, e.span, { kind: 'operation', role: 'decision', title: `\`${e.op}\``, inputs: [this.input(mod, e.left, left, 'operand'), this.input(mod, e.right, right, 'operand')], output: value, target: { kind: 'next' }, what: `The left side of \`${e.op}\` is not known, so the result is \`?\`.`, why: '`and`/`or` need the left side to decide.' });
          return { value, step, variable: null };
        }
        const shortCircuit = e.op === 'and' ? !truthy(left.value) : truthy(left.value);
        const inputs = [this.input(mod, e.left, left, 'operand')];
        let result: PyValue = left.value;
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
        let value: PyValue = { t: 'bool', v: true };
        for (let i = 0; i < e.ops.length; i++) {
          const right = this.eval(e.comparators[i]!, mod);
          inputs.push(this.input(mod, e.comparators[i]!, right, 'operand'));
          value = this.compare(e.ops[i]!, left.value, right.value);
          if (value.t === 'unknown' || (value.t === 'bool' && !value.v)) break;
          if (value.t !== 'bool' && e.ops.length > 1) throw new PyError('ValueError', 'The truth value of an array with more than one element is ambiguous. Use a.any() or a.all()');
          left = right;
        }
        const step = this.recordAt(mod, e.span, {
          kind: 'operation',
          role: 'decision',
          title: 'Compare',
          inputs,
          output: value,
          target: { kind: 'next' },
          what: `\`${this.text(mod, e.span)}\` → ${v(value)}.`,
          why: 'A comparison produces True or False, usually to decide which code runs next.',
        });
        return { value, step, variable: null };
      }
      case 'UnaryOp': {
        const operand = this.eval(e.operand, mod);
        const isArray = operand.value.t === 'series' || operand.value.t === 'ndarray';
        if (['dataframe', 'instance', 'method'].includes(operand.value.t) && e.op !== 'not') throw new UnsupportedError(`\`${e.op}\` on ${typeName(operand.value)} is not modelled.`);
        const result = operand.value.t === 'unknown' ? unknown(this.text(mod, e.span).slice(0, 60)) : e.op === '~' && isArray ? logicArrays('~', operand.value, null) : unaryOp(e.op, operand.value);
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
        if (test.value.t === 'unknown') {
          const value = unknown(this.text(mod, e.span).slice(0, 60));
          const step = this.recordAt(mod, e.span, { kind: 'decision', role: 'decision', title: 'Conditional expression', inputs: [this.input(mod, e.test, test, 'condition')], output: value, target: { kind: 'next' }, evidence: 'inferred', what: `\`${this.text(mod, e.test.span)}\` is not known, so which of the two values is chosen is not known either.`, why: '`a if condition else b` picks one of two values.' });
          return { value, step, variable: null };
        }
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
        if (e.index.type === 'Slice' || (e.index.type === 'Tuple' && e.index.elts.some((x) => x.type === 'Slice'))) return this.sliceAccess(e, base, mod);
        const index = this.eval(e.index, mod);
        if (base.value.t === 'unknown' || hasUnknown(index.value)) {
          const value = unknown(this.text(mod, e.span).slice(0, 60));
          const step = this.recordAt(mod, e.span, {
            kind: 'index',
            role: 'collection',
            title: 'Select (not known)',
            inputs: [this.input(mod, e.value, base, 'receiver'), this.input(mod, e.index, index, 'index')],
            output: value,
            target: { kind: 'next' },
            what: `Takes \`${this.text(mod, e.index.span)}\` from \`${this.text(mod, e.value.span)}\`, which is not known here, so the result is \`?\`.`,
            why: '`[…]` picks part of a collection.',
          });
          return { value, step, variable: null };
        }
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

  private sliceAccess(e: Extract<Expr, { type: 'Subscript' }>, base: Ev, mod: ModuleState): Ev {
    if (e.index.type !== 'Slice') throw new UnsupportedError('Slicing in several dimensions is not modelled.', e.span);
    const bound = (x: Expr | null) => (x ? this.eval(x, mod).value : null);
    const bounds = { lower: bound(e.index.lower), upper: bound(e.index.upper), step: bound(e.index.step) };
    const open = base.value.t === 'unknown' || Object.values(bounds).some((b) => b?.t === 'unknown');
    const value = open ? unknown(this.text(mod, e.span).slice(0, 60)) : this.adopt(sliceOf(base.value, bounds));
    const step = this.recordAt(mod, e.span, {
      kind: 'index',
      role: 'collection',
      title: 'Take a slice',
      inputs: [this.input(mod, e.value, base, 'receiver')],
      output: value,
      target: { kind: 'next' },
      what: `Takes the part \`[${this.text(mod, e.index.span)}]\` of \`${this.text(mod, e.value.span)}\` → ${v(value)}.`,
      why: '`[start:stop]` takes the items from start up to, but not including, stop.',
    });
    return { value, step, variable: null };
  }

  private attribute(e: Extract<Expr, { type: 'Attribute' }>, mod: ModuleState): Ev {
    const base = this.eval(e.value, mod);
    const value = base.value;
    this.lastReceiver = value;
    let result: PyValue;
    const opaque = (): Ev => ({ value: unknown(value.t === 'unknown' ? `${value.from}.${e.attr}` : value.t === 'module' ? `${value.name}.${e.attr}` : this.text(mod, e.span).slice(0, 60)), step: base.step, variable: null });
    if (value.t === 'unknown') return opaque();
    if (value.t === 'module') {
      if (value.origin === 'project' && value.path) {
        const target = this.moduleFor(value.path)!;
        const binding = target.globals.get(e.attr);
        if (!binding && target.partial) return opaque();
        if (!binding) throw new PyError('AttributeError', `module '${value.name}' has no attribute '${e.attr}'`);
        return { value: binding.value, step: binding.setAt, variable: null };
      }
      if (!value.modelled) return opaque();
      try {
        // Constants such as np.nan and functions such as np.sqrt need no step of their own.
        return { value: moduleAttribute(value.name, e.attr), step: null, variable: null };
      } catch (err) {
        if (err instanceof UnsupportedError) return opaque();
        throw err;
      }
    } else if (value.t === 'instance') {
      return this.instanceAttribute(value, base, e, mod);
    } else if (value.t === 'class') {
      const cls = this.classState(value);
      const member = cls ? this.lookupMember(cls, e.attr) : null;
      // Base classes outside the project (such as Enum) may change what class attributes mean.
      if (cls?.open && (!member || member.kind === 'attr')) return opaque();
      if (!member) throw new PyError('AttributeError', `type object '${value.name}' has no attribute '${e.attr}'`);
      if (member.kind === 'attr') return { value: member.value, step: null, variable: null };
      if (member.kind === 'unsupported') throw new UnsupportedError(member.reason, e.span);
      if (member.kind === 'property') throw new UnsupportedError('Reading a property from the class itself is not simulated.', e.span);
      return { value: { t: 'function', fn: member.fn }, step: null, variable: null };
    } else if (value.t === 'series' || value.t === 'ndarray' || value.t === 'dataframe') {
      try {
        result = objectAttribute(value, e.attr);
      } catch (err) {
        if (err instanceof UnsupportedError) return opaque();
        throw err;
      }
    } else if (hasContainerMethod(value, e.attr)) {
      return { value: { t: 'method', self: value, name: e.attr, owner: value.t }, step: base.step, variable: base.variable };
    } else {
      return opaque();
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
    const receiver = e.func.type === 'Attribute' ? this.lastReceiver : null;
    const argValues: PyValue[] = [];
    const kwMap = new Map<string, PyValue>();
    const inputs: StepInput[] = [];
    // `*args` / `**kwargs` that are not known may supply anything.
    let open = false;
    for (const a of e.args) {
      if (a.type === 'Starred') {
        const spread = this.eval(a.value, mod);
        if (spread.value.t === 'unknown') open = true;
        else
          for (const [i, item] of iterate(spread.value, this.maxIterations).entries()) {
            argValues.push(item);
            inputs.push(this.input(mod, a.value, { ...spread, value: item }, 'argument', `${this.text(mod, a.value.span)}[${i}]`));
          }
        continue;
      }
      const ev = this.eval(a, mod);
      argValues.push(ev.value);
      inputs.push(this.input(mod, a, ev, 'argument'));
    }
    for (const k of e.keywords) {
      const ev = this.eval(k.value, mod);
      if (k.name === null) {
        if (ev.value.t === 'dict') for (const [key, val] of ev.value.entries) kwMap.set(pyStrOf(key), val);
        else open = true;
        continue;
      }
      kwMap.set(k.name, ev.value);
      inputs.push(this.input(mod, k.value, ev, 'argument', `${k.name}=${this.text(mod, k.value.span)}`, k.name));
    }
    const fn = callee.value;
    const calleeText = this.text(mod, e.func.span);

    if (fn.t === 'unknown') {
      // Methods that change things in place: what they touched is no longer known.
      const method = e.func.type === 'Attribute' ? e.func.attr : '';
      const inPlace = IN_PLACE.has(method) || [...kwMap].some(([k, x]) => k === 'inplace' && x.t === 'bool' && x.v);
      if (inPlace) for (const x of [receiver, ...argValues]) if (x) this.mutate(x, unknown(calleeText));
      const why = OUTSIDE[fn.from] ?? (receiver?.t === 'module' || /^[\w.]+$/.test(fn.from) && UNMODELLED_BUILTINS.has(fn.from) ? `\`${fn.from}\` is not modelled.` : 'It depends on something that is not known here.');
      return this.notComputed(e, mod, why, inputs);
    }
    if (open && fn.t !== 'function' && fn.t !== 'bound' && fn.t !== 'class') return this.notComputed(e, mod, 'Some of its arguments are not known.', inputs);

    switch (fn.t) {
      case 'function':
        if (fn.fn.qualname.endsWith('<lambda>')) {
          const value = this.invoke(fn, argValues, mod, e.span);
          const step = this.recordAt(mod, e.span, { kind: 'builtin', role: 'function', title: 'Use small function', inputs, output: value, target: { kind: 'next' }, what: `The small function \`${calleeText}\` gives ${v(value)}.`, why: 'A lambda is a tiny one-line function.' });
          return { value, step, variable: null };
        }
        return this.callUser(fn.fn, argValues, kwMap, inputs, e.span, mod, calleeText, false, null, open);
      case 'exc-type':
        return { value: { t: 'exception', name: fn.name, message: argValues[0] ? (hasUnknown(argValues[0]) ? '…' : pyStrOf(argValues[0])) : '' }, step: null, variable: null };
      case 'bound': {
        const member = this.lookupMember(this.objectClass(fn.self), fn.fn.def.name);
        if (member?.kind === 'async') throw new UnsupportedError('Async methods (`async def`) are not simulated.', e.span);
        const receiverExpr = e.func.type === 'Attribute' ? e.func.value : e.func;
        const selfInput: StepInput = { label: this.text(mod, receiverExpr.span), value: fn.self, fromStep: callee.step, fromVariable: callee.variable, role: 'receiver', name: 'self' };
        return this.callUser(fn.fn, [fn.self, ...argValues], kwMap, [selfInput, ...inputs], e.span, mod, calleeText, false, null, open);
      }
      case 'builtin':
        if (fn.name === 'pandas.read_csv' && argValues[0]?.t === 'str') return this.readCsv(argValues, kwMap, inputs, e, mod, calleeText);
        if (fn.name.includes('.')) {
          if (argValues.some((x) => hasUnknown(x)) || [...kwMap.values()].some((x) => hasUnknown(x))) return this.notComputed(e, mod, 'Some of its inputs are not known.', inputs);
          let result: PyValue;
          try {
            result = callLibraryFunction(fn.name, argValues, kwMap);
          } catch (err) {
            if (err instanceof UnsupportedError) return this.notComputed(e, mod, err.message, inputs);
            throw err;
          }
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
        const receiverExpr = e.func.type === 'Attribute' ? e.func.value : e.func;
        const receiverInput = this.input(mod, receiverExpr, { value: fn.self, step: callee.step, variable: callee.variable }, 'receiver');
        const container = hasContainerMethod(fn.self, fn.name);
        // Putting `?` into a list is fine; computing with it is not.
        const stores = ['append', 'extend', 'insert', 'setdefault', 'update', 'get', 'add'].includes(fn.name);
        if ((argValues.some((x) => hasUnknown(x)) && !stores) || (argValues[0]?.t === 'unknown' && ['extend', 'update', 'get', 'setdefault'].includes(fn.name)) || [...kwMap.values()].some((x) => hasUnknown(x))) {
          if (container && ['extend', 'update', 'setdefault', 'remove', 'pop'].includes(fn.name)) this.mutate(fn.self, unknown(calleeText));
          return this.notComputed(e, mod, 'Some of its inputs are not known.', [receiverInput, ...inputs]);
        }
        let result: PyValue;
        try {
          if (fn.self.t === 'list' && fn.name === 'sort') {
            const sorted = this.sortValues(iterate(fn.self, 20000), kwMap, mod, e.span);
            this.mutate(fn.self, { t: 'list', items: sorted });
            result = NONE;
          } else if (container) {
            const done = callContainerMethod(this.fresh(fn.self), fn.name, argValues, kwMap);
            if (done.mutated) this.mutate(fn.self, done.mutated);
            result = done.result;
          } else if (hasNumericMethod(fn.self, fn.name)) result = callMethod(fn, argValues, kwMap);
          else throw new UnsupportedError(`\`.${fn.name}\` is not modelled in this form.`);
        } catch (err) {
          if (!(err instanceof UnsupportedError)) throw err;
          if (IN_PLACE.has(fn.name) || kwMap.has('inplace')) this.mutate(fn.self, unknown(calleeText));
          return this.notComputed(e, mod, err.message, [receiverInput, ...inputs]);
        }
        if (container) {
          const changes = result.t === 'none' && fn.self.t !== 'dict';
          const after = this.fresh(fn.self);
          const step = this.recordAt(mod, e.span, {
            kind: 'method',
            role: 'collection',
            title: `Call .${fn.name}()`,
            inputs: [receiverInput, ...inputs],
            output: changes ? after : result,
            target: { kind: 'next' },
            what: changes ? `\`${this.text(mod, receiverExpr.span)}.${fn.name}(…)\` changes it to ${v(after)}.` : `\`${this.text(mod, receiverExpr.span)}.${fn.name}(…)\` → ${v(result)}.`,
            why: `\`.${fn.name}()\` is a built-in ${typeName(fn.self)} method.`,
          });
          return { value: result, step, variable: null };
        }
        const step = this.recordAt(mod, e.span, {
          kind: 'method',
          role: 'function',
          title: `Call .${fn.name}()`,
          inputs: [receiverInput, ...inputs],
          output: result,
          target: { kind: 'next' },
          what: methodDescription(fn.name, this.text(mod, receiverExpr.span), fn.self, result, e.keywords.find((k) => k.name === 'dtype') ? this.text(mod, e.keywords.find((k) => k.name === 'dtype')!.value.span) : null),
          why: `\`.${fn.name}()\` is a ${fn.owner === 'Series' ? 'pandas' : 'NumPy'} method; the simulation models it in JavaScript.`,
        });
        return { value: result, step, variable: null };
      }
      case 'class': {
        const cls = this.classState(fn);
        if (!cls) throw new UnsupportedError(`Creating \`${fn.name}\` objects is not modelled.`, e.span);
        if (cls.excBase !== null && !this.lookupMember(cls, '__init__')) {
          return { value: { t: 'exception', name: cls.name, message: argValues[0] ? (hasUnknown(argValues[0]) ? '…' : pyStrOf(argValues[0])) : '' }, step: null, variable: null };
        }
        if (cls.open && !this.lookupMember(cls, '__init__') && !cls.fields) return this.notComputed(e, mod, `\`${cls.name}\` is built on something outside this project, so how its objects are made is not known.`, inputs);
        return this.instantiate(cls, argValues, kwMap, inputs, e.span, mod, open);
      }
      case 'module':
        if (!fn.modelled) return this.notComputed(e, mod, `It comes from \`${fn.name}\`, which is outside this project and not modelled.`, inputs);
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
    const allowed: Record<string, string[]> = { print: ['sep', 'end', 'flush', 'file'], sum: ['start'], round: ['ndigits'], sorted: ['reverse', 'key'], min: ['key', 'default'], max: ['key', 'default'], enumerate: ['start'], zip: ['strict'], dict: ['*'] };
    // `?` in → `?` out, except where the value itself is not needed.
    const tolerant = ['print', 'isinstance', 'list', 'tuple', 'dict', 'enumerate', 'zip', 'len', 'getattr', 'hasattr', 'callable', 'reversed', 'any', 'all'];
    const direct = args.some((x) => x.t === 'unknown') || [...kwargs.values()].some((x) => x.t === 'unknown');
    const nested = direct || args.some((x) => hasUnknown(x));
    if ((direct && !['print', 'isinstance'].includes(name)) || (nested && !tolerant.includes(name))) return this.notComputed(e, mod, 'Some of its inputs are not known.', inputs);
    for (const key of kwargs.keys()) {
      if (!(allowed[name] ?? []).includes(key) && allowed[name]?.[0] !== '*') throw new UnsupportedError(`Keyword \`${key}=\` of ${name}() is not modelled.`, e.span);
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
      case 'next': {
        arity(1, 2);
        const from = e.args[0];
        if (from?.type !== 'Comprehension' || from.kind !== 'generator') throw new UnsupportedError('next() is only modelled on a generator expression.', e.span);
        const items = iterate(args[0]!, this.maxIterations * 4);
        if (items.length === 0 && !args[1]) throw new PyError('StopIteration', '');
        result = items[0] ?? args[1]!;
        what = items.length > 0 ? `Takes the first one: ${v(result)}.` : `There is none, so it uses ${v(result)}.`;
        break;
      }
      case 'print': {
        const sep = kwargs.get('sep');
        const end = kwargs.get('end');
        if (end && !(end.t === 'str' && end.v === '\n')) notes.push('`end=` is ignored here: each print is shown on its own line.');
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
        for (const item of items) total = this.binary('+', total, item);
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
                    : x.t === 'set'
                      ? x.items.length
                      : null;
        if (n === null && (x.t === 'instance' || x.t === 'function')) throw new UnsupportedError(`len() of ${typeName(x)} is not modelled.`, e.span);
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
        const fallback = kwargs.get('default');
        if (items.length === 0 && fallback) {
          result = fallback;
          what = `There are no items, so the default ${v(result)} is used.`;
          break;
        }
        if (items.length === 0) throw new PyError('ValueError', `${name}() iterable argument is empty`);
        const key = kwargs.get('key');
        const rank = items.map((x) => (key && key.t !== 'none' ? this.invoke(key, [x], mod, e.span) : x));
        if (rank.some((r) => hasUnknown(r))) return this.notComputed(e, mod, 'The values to compare are not known.', inputs);
        let best = 0;
        for (let i = 1; i < items.length; i++) if (compareOp(name === 'max' ? '>' : '<', rank[i]!, rank[best]!)) best = i;
        result = items[best]!;
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
        result = { t: 'list', items: this.sortValues(iterate(args[0]!, this.maxIterations * 20), kwargs, mod, e.span) };
        what = `Returns a new sorted list → ${v(result)}.`;
        break;
      }
      case 'isinstance': {
        arity(2, 2);
        const answer = this.isInstance(args[0]!, args[1]!);
        result = answer === null ? unknown(this.text(mod, e.span).slice(0, 60)) : { t: 'bool', v: answer };
        what = answer === null ? `Whether \`${inputs[0]?.label ?? 'it'}\` is of that kind is not known here.` : `Is \`${inputs[0]?.label ?? 'it'}\` (${typeName(args[0]!)}) of that kind? ${answer ? 'Yes' : 'No'}.`;
        break;
      }
      case 'any':
      case 'all': {
        arity(1, 1);
        const items = iterate(args[0]!, this.maxIterations * 20);
        const decided = items.some((x) => x.t !== 'unknown' && truthy(x) === (name === 'any'));
        result = !decided && items.some((x) => x.t === 'unknown') ? unknown(this.text(mod, e.span).slice(0, 60)) : { t: 'bool', v: decided === (name === 'any') };
        what = `${name === 'any' ? 'Is at least one of them true' : 'Are all of them true'}? ${v(result)}.`;
        break;
      }
      case 'enumerate': {
        arity(1, 2);
        const start = numericOf(args[1] ?? kwargs.get('start') ?? { t: 'int', v: 0 }) ?? 0;
        result = { t: 'list', items: iterate(args[0]!, this.maxIterations * 4).map((x, i): PyValue => ({ t: 'tuple', items: [{ t: 'int', v: start + i }, x] })) };
        what = 'Numbers the items: each becomes a pair (number, item).';
        break;
      }
      case 'zip': {
        const lists = args.map((x) => iterate(x, this.maxIterations * 4));
        const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
        result = { t: 'list', items: Array.from({ length: n }, (_, i): PyValue => ({ t: 'tuple', items: lists.map((l) => l[i]!) })) };
        what = `Pairs up the items of ${args.length} collections.`;
        break;
      }
      case 'map':
      case 'filter': {
        const lists = args.slice(1).map((x) => iterate(x, this.maxIterations));
        const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
        const made = Array.from({ length: n }, (_, i) => this.invoke(args[0]!, lists.map((l) => l[i]!), mod, e.span));
        if (name === 'filter' && made.some((x) => x.t === 'unknown')) return this.notComputed(e, mod, 'Some of its inputs are not known.', inputs);
        result = { t: 'list', items: name === 'map' ? made : lists[0]!.filter((_, i) => truthy(made[i]!)) };
        what = name === 'map' ? 'Applies a function to every item.' : 'Keeps only the items that pass the test.';
        break;
      }
      case 'dict': {
        let d: Extract<PyValue, { t: 'dict' }> = { t: 'dict', entries: [] };
        const from = args[0];
        if (from?.t === 'dict') d = { t: 'dict', entries: from.entries };
        else if (from)
          for (const pair of iterate(from, this.maxIterations * 4)) {
            const kv = iterate(pair, 10);
            if (kv.length !== 2) throw new PyError('ValueError', 'dictionary update sequence element has the wrong length; 2 is required');
            d = dictSet(d, kv[0]!, kv[1]!);
          }
        for (const [k, x] of kwargs) d = dictSet(d, { t: 'str', v: k }, x);
        result = d;
        what = `Builds a dictionary with ${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'}.`;
        break;
      }
      case 'set':
      case 'frozenset':
        arity(0, 1);
        result = { t: 'set', items: args[0] ? uniqueItems(iterate(args[0], this.maxIterations * 4)) : [] };
        what = 'Collects the different values, each once.';
        break;
      case 'reversed':
        arity(1, 1);
        result = { t: 'list', items: iterate(args[0]!, this.maxIterations * 4).reverse() };
        what = 'Turns the order around.';
        break;
      case 'repr':
      case 'format':
        arity(1, 2);
        result = { t: 'str', v: name === 'repr' ? pyRepr(args[0]!) : formatValue(args[0]!, args[1]?.t === 'str' ? args[1].v : '') };
        what = `Makes the text ${v(result)}.`;
        break;
      case 'divmod':
        arity(2, 2);
        result = { t: 'tuple', items: [this.binary('//', args[0]!, args[1]!), this.binary('%', args[0]!, args[1]!)] };
        what = 'Divides and keeps the whole part and the rest.';
        break;
      case 'pow':
        arity(2, 2);
        result = this.binary('**', args[0]!, args[1]!);
        what = `Power → ${v(result)}.`;
        break;
      case 'callable':
        arity(1, 1);
        result = { t: 'bool', v: ['function', 'builtin', 'class', 'method', 'bound', 'exc-type'].includes(args[0]!.t) };
        what = `Can it be called? ${v(result)}.`;
        break;
      case 'getattr':
      case 'hasattr': {
        const [obj, attr] = args;
        if (obj?.t !== 'instance' || attr?.t !== 'str') throw new UnsupportedError(`${name}() is only modelled for objects of your own classes.`, e.span);
        const state = this.heap.get(obj.id)!;
        const field = state.fields.get(attr.v);
        const member = this.lookupMember(state.cls, attr.v);
        if (!field && (member || state.cls.open)) throw new UnsupportedError(`${name}() of a method is not modelled.`, e.span);
        if (name === 'getattr' && !field && !args[2]) throw new PyError('AttributeError', `'${state.cls.name}' object has no attribute '${attr.v}'`);
        result = name === 'hasattr' ? { t: 'bool', v: !!field } : field?.value ?? args[2]!;
        what = `\`${name}\` → ${v(result)}.`;
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

  private sortValues(items: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>, mod: ModuleState, span: Span): PyValue[] {
    const key = kwargs.get('key');
    const ranked = items.map((x) => ({ x, r: key && key.t !== 'none' ? this.invoke(key, [x], mod, span) : x }));
    if (ranked.some((p) => hasUnknown(p.r))) throw new UnsupportedError('The values to sort by are not known.');
    const less = (a: PyValue, b: PyValue): boolean => {
      if ((a.t === 'tuple' || a.t === 'list') && a.t === b.t) {
        const other = b as typeof a;
        for (let i = 0; i < Math.min(a.items.length, other.items.length); i++) if (!pyEquals(a.items[i]!, other.items[i]!)) return less(a.items[i]!, other.items[i]!);
        return a.items.length < other.items.length;
      }
      return compareOp('<', a, b);
    };
    const reverse = kwargs.get('reverse');
    const dir = reverse && truthy(reverse) ? -1 : 1;
    // JavaScript's sort is stable, like Python's (also for reverse=True).
    return ranked.sort((p, q) => dir * (less(p.r, q.r) ? -1 : less(q.r, p.r) ? 1 : 0)).map((p) => p.x);
  }

  /** `isinstance`, or null when it cannot be decided. */
  private isInstance(value: PyValue, kind: PyValue): boolean | null {
    if (kind.t === 'tuple') {
      const answers = kind.items.map((k) => this.isInstance(value, k));
      return answers.includes(true) ? true : answers.includes(null) ? null : false;
    }
    if (value.t === 'unknown' || kind.t === 'unknown') return null;
    if (kind.t === 'class') {
      if (value.t === 'exception') return this.isKindOf(value.name, kind.name);
      if (value.t !== 'instance') return false;
      const within = (c: ClassState): boolean => c.name === kind.name || c.bases.some(within);
      return within(this.objectClass(value));
    }
    if (kind.t === 'exc-type') return value.t === 'exception' ? this.isKindOf(value.name, kind.name) : false;
    if (kind.t !== 'builtin') return null;
    switch (kind.name) {
      case 'int':
        return value.t === 'int' || value.t === 'bool';
      case 'float':
        return value.t === 'float' || (value.t === 'np-scalar' && value.dtype === 'float64');
      case 'bool':
      case 'str':
      case 'list':
      case 'tuple':
      case 'dict':
      case 'set':
        return value.t === kind.name;
      case 'pandas.Series':
        return value.t === 'series';
      case 'pandas.DataFrame':
        return value.t === 'dataframe';
      case 'numpy.float64':
        return value.t === 'np-scalar' && value.dtype === 'float64';
      default:
        return null;
    }
  }

  private bindArguments(def: FunctionDef, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>, fnMod: ModuleState, lenient = false): Map<string, PyValue> {
    const bound = new Map<string, PyValue>();
    const positional = def.params.filter((p) => p.kind === 'positional');
    const rest = def.params.find((p) => p.kind === 'varargs');
    const extra = def.params.find((p) => p.kind === 'varkw');
    if (args.length > positional.length && !rest) {
      throw new PyError('TypeError', `${def.name}() takes ${positional.length} positional argument${positional.length === 1 ? '' : 's'} but ${args.length} were given`);
    }
    args.slice(0, positional.length).forEach((a, i) => bound.set(positional[i]!.name, a));
    if (rest) bound.set(rest.name, lenient && args.length <= positional.length ? unknown(`*${rest.name}`) : { t: 'tuple', items: args.slice(positional.length) });
    let spare: Extract<PyValue, { t: 'dict' }> = { t: 'dict', entries: [] };
    for (const [key, value] of kwargs) {
      const param = def.params.find((p) => p.name === key && p.kind !== 'varargs' && p.kind !== 'varkw');
      if (!param && extra) {
        spare = dictSet(spare, { t: 'str', v: key }, value);
        continue;
      }
      if (!param) throw new PyError('TypeError', `${def.name}() got an unexpected keyword argument '${key}'`);
      if (bound.has(key)) throw new PyError('TypeError', `${def.name}() got multiple values for argument '${key}'`);
      bound.set(key, value);
    }
    if (extra) bound.set(extra.name, this.adopt(lenient ? unknown(`**${extra.name}`) : spare));
    const missing: string[] = [];
    for (const p of def.params) {
      if (bound.has(p.name)) continue;
      if (lenient && !p.defaultValue) bound.set(p.name, unknown(p.name));
      else if (p.defaultValue) bound.set(p.name, this.eval(p.defaultValue, fnMod).value);
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
    lenient = synthetic,
  ): Ev {
    if (fn.def.isAsync) throw new UnsupportedError('`async def` functions are not modelled.');
    if (containsYield(fn.def.body) && !synthetic) throw new UnsupportedError(`\`${fn.def.name}\` is a generator (it uses \`yield\`), which is not modelled.`);
    const open = this.frames.filter((f) => f.kind === 'function' && f.name === fn.qualname).length;
    if (open >= MAX_UNKNOWN_RECURSION && (this.unknownTurns > 0 || args.some((x) => hasUnknown(x)))) {
      throw new UnsupportedError(`\`${fn.def.name}\` calls itself again, and when it stops is not known here.`);
    }
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
    const bound = this.bindArguments(fn.def, args, kwargs, fnMod, lenient);
    const callerFrame = this.frame;
    const locals = new Map<string, Binding>();
    const enterStepId = this.nextId;
    for (const [name, value] of bound) locals.set(name, { value, setAt: enterStepId });
    this.pushFrame({ name: fn.qualname, kind: 'function', locals, module: fnMod, outer: new Map(), endsInRaise: fn.def.body[fn.def.body.length - 1]?.type === 'Raise', ...(fn.closure ? { closure: fn.closure } : {}) });
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
    let excBase: string | null = null;
    let open = false;
    for (const b of s.bases) {
      if (b.type === 'Name' && b.id === 'object') continue;
      const base = this.eval(b, mod).value;
      if (base.t === 'exc-type') {
        excBase = base.name;
        continue;
      }
      const state = base.t === 'class' ? this.classState(base) : null;
      if (!state) {
        open = true;
        continue;
      }
      if (state.excBase !== null) excBase = state.name;
      bases.push(state);
    }
    if (excBase !== null) this.excParents.set(s.name, excBase);
    const members = new Map<string, Member>();
    const fields: Array<{ name: string; defaultValue: PyValue | null }> = [];
    const isDataclass = s.decorators.length === 1 && /^(dataclasses\.)?dataclass\b/.test(this.text(mod, s.decorators[0]!.span));
    const cls: ClassState = { name: s.name, path: mod.path, headerSpan: s.headerSpan, bases, members, excBase, open, fields: isDataclass ? fields : null };
    const described: string[] = [];
    // `@dataclass` writes `__init__` from the annotated fields; other class decorators are not modelled.
    const decorators = s.decorators.map((d) => this.text(mod, d.span));
    if (decorators.length > 0 && !isDataclass) throw new UnsupportedError(`The class decorator \`@${decorators.join(' @')}\` is not modelled.`, s.headerSpan);
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
        const value = this.eval(item.value, mod).value;
        members.set(item.targets[0].id, { kind: 'attr', value });
        if (isDataclass) fields.push({ name: item.targets[0].id, defaultValue: value });
        described.push(item.targets[0].id);
      } else if (item.type === 'Pass' || (item.type === 'Expr' && item.isDocstring)) {
        continue;
      } else if (item.type === 'Declare') {
        if (isDataclass && item.name) fields.push({ name: item.name, defaultValue: null });
      } else {
        this.skip(mod, item.span, 'This statement inside a class body is not modelled');
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
  private instantiate(cls: ClassState, args: readonly PyValue[], kwargs: ReadonlyMap<string, PyValue>, inputs: StepInput[], span: Span, mod: ModuleState, lenient = false): Ev {
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
      const result = this.callUser(init.fn, [ref, ...args], kwargs, [selfInput, ...inputs], span, mod, `${cls.name}.__init__`, false, createStep, lenient);
      if (result.value.t !== 'none') throw new PyError('TypeError', `__init__() should return None, not '${typeName(result.value)}'`);
    } else if (init) {
      throw new UnsupportedError(`This kind of \`__init__\` is not simulated.`, span);
    } else if (cls.fields) {
      if (args.length > cls.fields.length) throw new PyError('TypeError', `${cls.name}.__init__() takes ${cls.fields.length + 1} positional arguments but ${args.length + 1} were given`);
      const missing: string[] = [];
      cls.fields.forEach((f, i) => {
        const value = args[i] ?? kwargs.get(f.name) ?? f.defaultValue ?? (lenient ? unknown(f.name) : null);
        if (value) this.heap.get(id)!.fields.set(f.name, { value, setAt: createStep >= 0 ? createStep : null });
        else missing.push(f.name);
      });
      const odd = [...kwargs.keys()].find((k) => !cls.fields!.some((f) => f.name === k));
      if (odd) throw new PyError('TypeError', `${cls.name}.__init__() got an unexpected keyword argument '${odd}'`);
      if (missing.length > 0) throw new PyError('TypeError', `${cls.name}.__init__() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${missing.map((m) => `'${m}'`).join(' and ')}`);
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
    if (!member && (state.cls.open || state.cls.bases.some((b) => b.open))) return { value: unknown(this.text(mod, e.span)), step: null, variable: null };
    if (!member && /^__\w+__$/.test(e.attr)) throw new UnsupportedError(`\`${e.attr}\` is not modelled.`, e.span);
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
      const made = this.instantiate(cls, [], entry.initArgs, initInputs, cls.headerSpan, mod, true);
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
    const def = mod.ast.body.find((s): s is FunctionDef => s.type === 'FunctionDef' && s.name === name);
    if (!def) throw new UnsupportedError(`\`${name}\` is not a top-level function in ${mod.path}.`);
    const bound = mod.globals.get(name)?.value;
    const fn: FunctionValue = bound?.t === 'function' ? bound.fn : { def, path: mod.path, qualname: name };
    if (def.decorators.length > 0) this.assumptions.push(`The decorators of \`${name}\` (${def.decorators.map((d) => `@${this.text(mod, d.span)}`).join(', ')}) are left out: the function itself is run.`);
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

/** Names that a block assigns in its own scope (nested functions and classes excluded). */
function assignedNames(stmts: readonly Stmt[]): Set<string> {
  const names = new Set<string>();
  const target = (t: Expr): void => {
    if (t.type === 'Name') names.add(t.id);
    else if (t.type === 'Tuple' || t.type === 'List') t.elts.forEach(target);
    else if (t.type === 'Starred') target(t.value);
  };
  const visit = (s: Stmt): void => {
    switch (s.type) {
      case 'Assign':
        s.targets.forEach(target);
        break;
      case 'AugAssign':
        target(s.target);
        break;
      case 'If':
        s.branches.forEach((b) => b.body.forEach(visit));
        s.orelse?.forEach(visit);
        break;
      case 'For':
        target(s.target);
        s.body.forEach(visit);
        s.orelse.forEach(visit);
        break;
      case 'While':
        s.body.forEach(visit);
        s.orelse.forEach(visit);
        break;
      case 'With':
        s.items.forEach((i) => i.target && target(i.target));
        s.body.forEach(visit);
        break;
      case 'Try':
        s.body.forEach(visit);
        s.handlers.forEach((h) => h.body.forEach(visit));
        s.orelse.forEach(visit);
        s.finalbody.forEach(visit);
        break;
    }
  };
  stmts.forEach(visit);
  return names;
}

/** The inside of an expression ran for too long. */
class TooLong extends Error {}

/** Whether a function body yields (and so is a generator), ignoring nested functions. */
function containsYield(stmts: readonly Stmt[]): boolean {
  const visit = (n: unknown): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (Array.isArray(n)) return n.some(visit);
    const node = n as { type?: string };
    if (node.type === 'Yield') return true;
    if (node.type === 'FunctionDef' || node.type === 'Lambda' || node.type === 'ClassDef') return false;
    return Object.entries(n).some(([k, x]) => k !== 'span' && k !== 'headerSpan' && visit(x));
  };
  return stmts.some(visit);
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
