import type { SourceSpan } from '../source-mapping/types';
import type { PyValue } from './values';

/**
 * The output of a simulation run: an ordered list of steps, each tied to an
 * exact source span. Renderers (3D, 2D, explanation panel) only read this.
 */

export type StepKind =
  | 'import'
  | 'define'
  | 'assign'
  | 'operation'
  | 'builtin'
  | 'call'
  | 'enter'
  | 'method'
  | 'index'
  | 'return'
  | 'print'
  | 'decision'
  | 'loop'
  | 'error'
  /** Something the simulation cannot compute; the result is `?` and the run continues. */
  | 'unknown'
  | 'unsupported';

/** Which visual metaphor represents the step (see the visual vocabulary). */
export type VisualRole = 'variable' | 'value' | 'collection' | 'function' | 'decision' | 'loop' | 'return';

export interface StepInput {
  /** Exact source text of the input expression, or the parameter name. */
  readonly label: string;
  readonly value: PyValue;
  /** Step that produced this value (an operation or the assignment that stored the variable). */
  readonly fromStep: number | null;
  /** Variable the value was read from, when it came straight from a name. */
  readonly fromVariable: string | null;
  readonly role: 'operand' | 'argument' | 'receiver' | 'index' | 'condition' | 'value' | 'iterable';
  /** Parameter / keyword name the input binds to, when relevant. */
  readonly name?: string;
}

export type StepTarget =
  | { readonly kind: 'variable'; readonly names: readonly string[]; readonly frameId: number }
  | { readonly kind: 'params'; readonly names: readonly string[]; readonly frameId: number }
  | { readonly kind: 'return'; readonly callerFrameId: number; readonly callStep: number | null }
  | { readonly kind: 'console' }
  | { readonly kind: 'branch'; readonly taken: boolean }
  | { readonly kind: 'next' };

export interface VarSnapshot {
  readonly name: string;
  readonly value: PyValue;
  /** Step that last stored this variable. */
  readonly setAt: number | null;
}

export interface FrameSnapshot {
  readonly id: number;
  /** `<module>` or the function's qualified name. */
  readonly name: string;
  readonly path: string;
  readonly kind: 'module' | 'function';
  readonly vars: readonly VarSnapshot[];
}

export interface Step {
  readonly id: number;
  readonly kind: StepKind;
  readonly role: VisualRole;
  /** Short operation name, e.g. "Multiply" or "Call function". */
  readonly title: string;
  readonly span: SourceSpan;
  /** Exact original source text covered by `span`. */
  readonly code: string;
  readonly inputs: readonly StepInput[];
  readonly output: PyValue | null;
  readonly target: StepTarget | null;
  /** Element position chosen by an indexing step. */
  readonly selectedIndex: number | null;
  readonly frameId: number;
  /** Call stack after the step, outermost first. */
  readonly frames: readonly FrameSnapshot[];
  /** Number of console lines printed so far (including this step). */
  readonly consoleLength: number;
  readonly explanation: { readonly what: string; readonly why: string };
  readonly notes: readonly string[];
  /** First later step that consumes this step's output. Filled after the run. */
  usedBy: number | null;
  readonly evidence: 'simulated' | 'inferred' | 'unsupported';
  /** Set when a decision depended on `?`: which way the run went, and the key to flip it. */
  readonly assumption: { readonly key: string; readonly taken: boolean } | null;
}

export interface Trace {
  readonly entryLabel: string;
  readonly steps: readonly Step[];
  readonly console: readonly string[];
  readonly status: 'completed' | 'stopped';
  readonly stop: { readonly kind: 'unsupported' | 'error' | 'limit' | 'missing-data'; readonly message: string; readonly path?: string } | null;
  /** Assumptions the run makes (e.g. "runs as the main script"). */
  readonly assumptions: readonly string[];
  /** Executable statements not shown as steps, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly reason: string; readonly span: SourceSpan }>;
}
