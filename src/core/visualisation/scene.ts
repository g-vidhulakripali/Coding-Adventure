import type { Step, StepInput, Trace, VisualRole } from '../simulation/trace';
import { displayValue, elementDisplay, elementsOf, tablePreview, typeLabel, type PyValue } from '../simulation/values';
import { storyFor, type Story } from './story';

/**
 * Renderer-agnostic description of what to draw for one step.
 *
 * Both the 3D laboratory and the 2D fallback render a `Scene`; neither reads
 * the trace directly. Every token carries the exact source text it represents.
 */

export interface SceneValue {
  readonly display: string;
  readonly type: string;
  /** Element-wise display for collections (lists, arrays, Series). */
  readonly elements: readonly string[] | null;
  /** Fields of an object (one container holding its data). */
  readonly fields?: ReadonlyArray<readonly [string, string]>;
  /** Preview of a table. */
  readonly table?: { readonly header: readonly string[]; readonly rows: ReadonlyArray<readonly string[]>; readonly more: number };
}

export interface SceneVariable extends SceneValue {
  readonly name: string;
  /** Stored by the current step. */
  readonly changed: boolean;
}

export interface SceneFrame {
  readonly id: number;
  readonly label: string;
  readonly path: string;
  readonly kind: 'module' | 'function';
  readonly vars: readonly SceneVariable[];
}

export type TokenSource =
  | { readonly kind: 'variable'; readonly frameId: number; readonly name: string }
  | { readonly kind: 'caller'; readonly frameId: number }
  | { readonly kind: 'previous' }
  | { readonly kind: 'literal' };

export interface SceneToken extends SceneValue {
  /** Exact source text (or parameter name) this value corresponds to. */
  readonly label: string;
  readonly role: StepInput['role'];
  readonly source: TokenSource;
}

export type SceneDestination =
  | { readonly kind: 'variable'; readonly frameId: number; readonly names: readonly string[] }
  | { readonly kind: 'params'; readonly frameId: number; readonly names: readonly string[] }
  | { readonly kind: 'return'; readonly toFrameId: number }
  | { readonly kind: 'console' }
  | { readonly kind: 'branch'; readonly taken: boolean }
  | { readonly kind: 'next' }
  | { readonly kind: 'none' };

export interface SceneOperation {
  readonly stepId: number;
  readonly kind: Step['kind'];
  readonly role: VisualRole;
  readonly title: string;
  readonly code: string;
  readonly inputs: readonly SceneToken[];
  readonly output: SceneToken | null;
  readonly destination: SceneDestination;
  /** Highlighted element: position within the first collection input (index/loop steps). */
  readonly selectedIndex: number | null;
  readonly status: 'ok' | 'error' | 'unsupported';
}

export interface Scene {
  /** Plain-language headline and picture-sum for this step. */
  readonly story: Story;
  readonly frames: readonly SceneFrame[];
  readonly operation: SceneOperation;
  readonly console: readonly string[];
  readonly stepNumber: number;
  readonly totalSteps: number;
}

const HIDDEN_KINDS = new Set(['function', 'builtin', 'module', 'class', 'method', 'iloc', 'bound']);

export function sceneValue(value: PyValue): SceneValue {
  const elements = elementsOf(value);
  return {
    display: displayValue(value, 60),
    type: typeLabel(value),
    elements: elements ? elements.map(elementDisplay) : null,
    ...(value.t === 'instance' ? { fields: value.fields.map(([k, f]) => [k, displayValue(f, 18)] as const) } : {}),
    ...(value.t === 'dataframe' ? { table: tablePreview(value, 4) } : {}),
  };
}

function frameLabel(name: string, path: string, kind: 'module' | 'function'): string {
  if (name === '<simulation>') return 'Your inputs';
  return kind === 'module' ? path : `${name}() · ${path}`;
}

export function buildScene(trace: Trace, index: number): Scene | null {
  const step = trace.steps[index];
  if (!step) return null;

  const frames: SceneFrame[] = step.frames.map((f) => ({
    id: f.id,
    label: frameLabel(f.name, f.path, f.kind),
    path: f.path,
    kind: f.kind,
    vars: f.vars
      .filter((v) => !HIDDEN_KINDS.has(v.value.t))
      .map((v) => ({ name: v.name, ...sceneValue(v.value), changed: v.setAt === step.id })),
  }));
  const current = frames[frames.length - 1];
  const callerFrameId = frames.length > 1 ? frames[frames.length - 2]!.id : null;

  const tokenSource = (input: StepInput): TokenSource => {
    if (step.kind === 'enter' && callerFrameId !== null) return { kind: 'caller', frameId: callerFrameId };
    if (input.fromVariable && current?.vars.some((v) => v.name === input.fromVariable)) {
      return { kind: 'variable', frameId: current.id, name: input.fromVariable };
    }
    if (input.fromVariable && callerFrameId !== null && step.kind === 'call') return { kind: 'variable', frameId: step.frameId, name: input.fromVariable };
    if (input.fromStep !== null) return { kind: 'previous' };
    return { kind: 'literal' };
  };

  const inputs: SceneToken[] = step.inputs
    .filter((i) => !HIDDEN_KINDS.has(i.value.t) || step.kind === 'import')
    .map((i) => ({ label: i.label, role: i.role, source: tokenSource(i), ...sceneValue(i.value) }));

  const output: SceneToken | null =
    step.output && !(step.kind === 'print' && step.output.t === 'none')
      ? { label: step.code.length > 40 ? `${step.code.slice(0, 39)}…` : step.code, role: 'value', source: { kind: 'previous' }, ...sceneValue(step.output) }
      : null;

  const t = step.target;
  const destination: SceneDestination = !t
    ? { kind: 'none' }
    : t.kind === 'variable'
      ? { kind: 'variable', frameId: t.frameId, names: t.names }
      : t.kind === 'params'
        ? { kind: 'params', frameId: t.frameId, names: t.names }
        : t.kind === 'return'
          ? { kind: 'return', toFrameId: t.callerFrameId }
          : t.kind === 'console'
            ? { kind: 'console' }
            : t.kind === 'branch'
              ? { kind: 'branch', taken: t.taken }
              : { kind: 'next' };

  return {
    story: storyFor(step, trace),
    frames,
    operation: {
      stepId: step.id,
      kind: step.kind,
      role: step.role,
      title: step.title,
      code: step.code,
      inputs,
      output,
      destination,
      selectedIndex: step.selectedIndex,
      status: step.kind === 'error' ? 'error' : step.kind === 'unsupported' ? 'unsupported' : 'ok',
    },
    console: trace.console.slice(0, step.consoleLength),
    stepNumber: index + 1,
    totalSteps: trace.steps.length,
  };
}

/** Plain-language destination, e.g. "stored in `total`". */
export function describeDestination(d: SceneDestination, frames: readonly SceneFrame[]): string {
  switch (d.kind) {
    case 'variable':
      return `stored in ${d.names.map((n) => `\`${n}\``).join(', ')}`;
    case 'params':
      return `becomes parameter${d.names.length === 1 ? '' : 's'} ${d.names.map((n) => `\`${n}\``).join(', ')}`;
    case 'return': {
      const to = frames.find((f) => f.id === d.toFrameId);
      return `sent back to ${to ? to.label : 'the caller'}`;
    }
    case 'console':
      return 'printed to the console';
    case 'branch':
      return d.taken ? 'enters the branch' : 'skips the branch';
    case 'next':
      return 'used by the next operation';
    case 'none':
      return '—';
  }
}
