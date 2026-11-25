import type { Step, StepInput, Trace } from '../simulation/trace';
import { displayValue, elementDisplay, elementsOf, tablePreview, type PyValue } from '../simulation/values';

/**
 * Plain-language "story" for a simulation step, written so a young child can
 * follow it: one short sentence, a picture-sum made of tiles, and where the
 * answer goes next. Generated only from the recorded step — nothing invented.
 * (The technical explanation stays in the step card and Explain panel.)
 */

export type StoryTile =
  | { readonly kind: 'value'; readonly text: string; readonly caption?: string; readonly source?: string }
  | { readonly kind: 'result'; readonly text: string; readonly caption?: string }
  | { readonly kind: 'op'; readonly text: string }
  | { readonly kind: 'box'; readonly name: string }
  | { readonly kind: 'list'; readonly items: readonly string[]; readonly selected: number | null; readonly caption?: string; readonly source?: string }
  | { readonly kind: 'helper'; readonly name: string }
  | { readonly kind: 'place'; readonly text: string; readonly icon: string }
  /** A small table preview (pandas DataFrame). */
  | { readonly kind: 'table'; readonly header: readonly string[]; readonly rows: ReadonlyArray<readonly string[]>; readonly more: number; readonly caption?: string; readonly source?: string; readonly highlight?: string }
  /** An object: one container holding its fields. */
  | { readonly kind: 'object'; readonly cls: string; readonly fields: ReadonlyArray<readonly [string, string]>; readonly caption?: string; readonly source?: string };

export interface Story {
  readonly icon: string;
  /** One to three words for the stage, e.g. "multiply" or "→ subtotal". The numbers do the rest. */
  readonly label: string;
  /** The full plain-language sentence (shown in the step card, not on the stage). */
  readonly headline: string;
  readonly tiles: readonly StoryTile[];
  /** Where the answer goes next, in plain words. */
  readonly next: string | null;
  readonly tone: 'normal' | 'error' | 'stop';
}

const MAX_LIST = 8;

const BUILTIN_LABELS: Record<string, string> = {
  len: 'count',
  float: 'make decimal',
  int: 'make whole',
  str: 'make text',
  bool: 'yes or no',
  abs: 'no minus',
  round: 'round',
  max: 'biggest',
  min: 'smallest',
  range: 'count up',
  list: 'list',
  tuple: 'list',
  sorted: 'in order',
};

const METHOD_LABELS: Record<string, string> = {
  to_numpy: 'plain numbers',
  sum: 'add up',
  mean: 'average',
  max: 'biggest',
  min: 'smallest',
  tolist: 'list',
};
const short = (v: PyValue) => displayValue(v, 22);

function valueTile(v: PyValue, caption?: string, source?: string | null): StoryTile {
  const items = elementsOf(v);
  const extra = { ...(caption ? { caption } : {}), ...(source ? { source } : {}) };
  if (v.t === 'dataframe') return { kind: 'table', ...tablePreview(v, 3), ...extra };
  if (v.t === 'instance') return { kind: 'object', cls: v.cls, fields: v.fields.map(([k, f]) => [k, displayValue(f, 16)] as const), ...extra };
  if (items) return { kind: 'list', items: items.slice(0, MAX_LIST).map(elementDisplay), selected: null, ...extra };
  return { kind: 'value', text: short(v), ...extra };
}

/** A tile for an input, remembering the box it was read from. */
function inputTile(input: StepInput): StoryTile {
  return valueTile(input.value, captionOf(input), input.fromVariable);
}

function resultTile(v: PyValue): StoryTile {
  if (v.t === 'dataframe' || v.t === 'instance') return valueTile(v);
  const items = elementsOf(v);
  if (items) return { kind: 'list', items: items.slice(0, MAX_LIST).map(elementDisplay), selected: null, caption: 'answer' };
  return { kind: 'result', text: short(v) };
}

/** Caption for an input: the variable it came from, when that is simpler than the value itself. */
function captionOf(input: StepInput): string | undefined {
  if (input.fromVariable) return input.fromVariable;
  if (input.name && input.name !== input.label) return input.name;
  return /^[A-Za-z_]\w*$/.test(input.label) ? input.label : undefined;
}

/** How to mention an input in a sentence: its value when short, otherwise its name. */
function say(input: StepInput): string {
  const text = short(input.value);
  if (elementsOf(input.value) || text.length > 12) return `“${captionOf(input) ?? nameOf(input)}”`;
  return text;
}

function nameOf(input: StepInput | undefined): string {
  if (!input) return 'it';
  return input.fromVariable ?? (/^[A-Za-z_][\w.]*$/.test(input.label) ? input.label : 'the list');
}

function and(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const OPS: Record<string, { sym: string; say: (a: string, b: string) => string }> = {
  Add: { sym: '+', say: (a, b) => `Add ${a} and ${b}.` },
  Subtract: { sym: '−', say: (a, b) => `Take ${b} away from ${a}.` },
  Multiply: { sym: '×', say: (a, b) => `Multiply ${a} by ${b}.` },
  Divide: { sym: '÷', say: (a, b) => `Divide ${a} by ${b}.` },
  'Floor-divide': { sym: '÷', say: (a, b) => `Divide ${a} by ${b} and keep only the whole number.` },
  Remainder: { sym: 'rem', say: (a, b) => `Divide ${a} by ${b} and keep what is left over.` },
  Power: { sym: '^', say: (a, b) => `Multiply ${a} by itself ${b} times.` },
};

function helperName(step: Step): string {
  const code = step.code.trim();
  const paren = code.indexOf('(');
  return paren > 0 ? code.slice(0, paren).trim() : code;
}

function nextSentence(step: Step, trace: Trace): string | null {
  const t = step.target;
  if (t?.kind === 'console') return 'You can see it in the console.';
  if (t?.kind === 'return') return 'The answer goes back to where the helper was asked.';
  const used = step.usedBy !== null ? trace.steps[step.usedBy] : null;
  if (!used || !step.output) return null;
  const answer = short(step.output);
  switch (used.kind) {
    case 'assign':
      return used.target?.kind === 'variable' ? `Next, ${answer} goes into the box called ${and(used.target.names.map((n) => `“${n}”`))}.` : null;
    case 'return':
      return `Next, the helper sends ${answer} back.`;
    case 'call':
      return `Next, ${answer} is handed to the helper “${helperName(used)}”.`;
    case 'print':
      return `Next, ${answer} is shown in the console.`;
    case 'index':
      return `Next, ${answer} is used to pick a spot in a list.`;
    case 'decision':
      return `Next, it decides what happens.`;
    default:
      return `Next, ${answer} is used in “${used.code.replace(/\s+/g, ' ').trim().slice(0, 40)}”.`;
  }
}

export function storyFor(step: Step, trace: Trace): Story {
  const base = buildStory(step);
  return { ...base, next: base.tone === 'normal' ? nextSentence(step, trace) : null };
}

function buildStory(step: Step): Omit<Story, 'next'> {
  const [a, b] = step.inputs;
  const out = step.output;
  const normal = (icon: string, label: string, headline: string, tiles: StoryTile[]) => ({ icon, label, headline, tiles, tone: 'normal' as const });

  switch (step.kind) {
    case 'import': {
      const names = step.target?.kind === 'variable' ? step.target.names : [];
      if (step.title === 'Load project module') {
        const file = /is found in this project at ([^\s]+?)\.(\s|$)/.exec(step.explanation.what)?.[1] ?? 'another file';
        return normal('📂', `open ${file}`, `Open the file ${file} to find what we need.`, []);
      }
      if (step.title === 'Import names') {
        return normal('📥', `${names.join(', ')} ready`, `Now this file can use ${and(names.map((n) => `“${n}”`))}.`, [
          ...names.map((n): StoryTile => ({ kind: 'helper', name: n })),
        ]);
      }
      const lib = /^(?:from\s+([\w.]+)|import\s+([\w.]+))/.exec(step.code.trim());
      const libName = lib?.[1] ?? lib?.[2] ?? names[0] ?? 'a library';
      return normal('🧰', libName, `Bring in the toolbox “${libName}”${names[0] && names[0] !== libName ? ` and call it “${names[0]}”` : ''}.`, []);
    }
    case 'define': {
      const name = step.target?.kind === 'variable' ? step.target.names[0]! : 'it';
      if (step.title === 'Define class') return normal('🧩', `new: ${name}`, `Learn about a new kind of thing called “${name}”.`, [{ kind: 'helper', name }]);
      return normal('📜', `recipe: ${name}`, `Learn a new recipe called “${name}”. It does not run yet — only when someone asks for it.`, [{ kind: 'helper', name }]);
    }
    case 'assign': {
      const names = step.target?.kind === 'variable' ? step.target.names : [];
      if (!out) return normal('📦', 'store', 'Store a value.', []);
      if (step.title.startsWith('Update')) {
        return normal('✏️', `→ ${names[0]}`, `Change the box “${names[0]}” to ${short(out)}.`, [valueTile(out), { kind: 'op', text: '→' }, { kind: 'box', name: names[0] ?? '?' }]);
      }
      return normal('📦', `→ ${names.join(', ')}`, `Put ${short(out)} into the box called ${and(names.map((n) => `“${n}”`))}.`, [
        valueTile(out),
        { kind: 'op', text: '→' },
        ...names.map((n): StoryTile => ({ kind: 'box', name: n })),
      ]);
    }
    case 'operation': {
      const op = OPS[step.title];
      if (op && a && b && out) {
        return normal('🧮', step.title.toLowerCase(), op.say(say(a), say(b)), [
          inputTile(a),
          { kind: 'op', text: op.sym },
          inputTile(b),
          { kind: 'op', text: '=' },
          resultTile(out),
        ]);
      }
      if (step.title === 'Compare' && out) {
        const yes = out.t === 'bool' && out.v;
        return normal('⚖️', yes ? 'yes' : 'no', `Check: is “${step.code.replace(/\s+/g, ' ').trim()}” true? ${yes ? 'Yes!' : 'No.'}`, [
          ...step.inputs.flatMap((i, n): StoryTile[] => (n === 0 ? [valueTile(i.value, captionOf(i))] : [{ kind: 'op', text: '?' }, valueTile(i.value, captionOf(i))])),
          { kind: 'op', text: '=' },
          { kind: 'result', text: yes ? 'Yes' : 'No' },
        ]);
      }
      if (out) return normal('🧮', 'work out', `Work out “${step.code.replace(/\s+/g, ' ').trim()}”. The answer is ${short(out)}.`, [{ kind: 'op', text: '=' }, resultTile(out)]);
      return normal('🧮', 'work out', 'Work something out.', []);
    }
    case 'builtin': {
      const fn = /Built-in (\w+)\(\)/.exec(step.title)?.[1] ?? step.title;
      const input = a;
      if (fn === 'sum' && input && out) {
        const items = elementsOf(input.value);
        if (items && items.length > 0 && items.length <= 6) {
          const tiles: StoryTile[] = [];
          items.forEach((item, i) => {
            if (i > 0) tiles.push({ kind: 'op', text: '+' });
            tiles.push({ kind: 'value', text: elementDisplay(item), ...(input.fromVariable ? { source: input.fromVariable } : {}) });
          });
          return normal('➕', `add up ${nameOf(input)}`, `Add up all the numbers in “${nameOf(input)}”.`, [...tiles, { kind: 'op', text: '=' }, resultTile(out)]);
        }
        return normal('➕', `add up ${nameOf(input)}`, `Add up all the numbers in “${nameOf(input)}”. The total is ${short(out)}.`, [valueTile(input.value, captionOf(input)), { kind: 'op', text: '=' }, resultTile(out)]);
      }
      if (!out) return normal('🔧', fn, step.title, []);
      const from: StoryTile[] = input ? [inputTile(input), { kind: 'op', text: '→' }] : [];
      const sayFn: Record<string, string> = {
        len: `Count the items in “${nameOf(input)}”. There are ${short(out)}.`,
        float: `Turn ${input ? say(input) : 'it'} into a normal decimal number.`,
        int: `Turn ${input ? say(input) : 'it'} into a whole number.`,
        str: `Turn ${input ? say(input) : 'it'} into text.`,
        bool: `Is it something or nothing? ${short(out)}.`,
        abs: `Take away the minus sign.`,
        round: `Round ${input ? say(input) : 'it'} to the nearest number.`,
        max: `Find the biggest one.`,
        min: `Find the smallest one.`,
        range: `Make a counting list.`,
        list: `Make a list.`,
        tuple: `Make a list that cannot change.`,
        sorted: `Put the items in order, smallest first.`,
      };
      if (step.title === 'Read CSV file') {
        const file = /reads (\S+) from this project/.exec(step.explanation.what)?.[1] ?? 'the file';
        const rows = out.t === 'dataframe' ? (out.columns[0]?.items.length ?? 0) : 0;
        const cols = out.t === 'dataframe' ? out.columns.length : 0;
        return normal('📄', `read ${file}`, `Open the table in ${file}: ${rows} rows and ${cols} columns.`, [{ kind: 'place', icon: '📄', text: file }, { kind: 'op', text: '→' }, resultTile(out)]);
      }
      if (step.title === 'Create pandas Series') return normal('🗂️', 'new column', 'Make a pandas column holding these numbers.', [...from, resultTile(out)]);
      if (step.title === 'Create NumPy array') return normal('🗂️', 'new list', 'Make a NumPy list of numbers.', [...from, resultTile(out)]);
      return normal('🔧', BUILTIN_LABELS[fn] ?? fn, sayFn[fn] ?? `Use the tool ${fn}().`, [...from, resultTile(out)]);
    }
    case 'print': {
      const text = step.inputs.map((i) => (i.value.t === 'str' ? i.value.v : say(i))).join(' ');
      return normal('🖥️', 'print', `Show ${text} in the console.`, [...step.inputs.map(inputTile), { kind: 'op', text: '→' }, { kind: 'place', icon: '🖥️', text: '' }]);
    }
    case 'call': {
      if (step.title === 'Create object' && out?.t === 'instance') {
        return normal('🧩', `new ${out.cls}`, `Make a new “${out.cls}” object: a container that will hold its own data.`, [
          ...step.inputs.map(inputTile),
          ...(step.inputs.length ? [{ kind: 'op', text: '→' } as StoryTile] : []),
          { kind: 'object', cls: out.cls, fields: [] },
        ]);
      }
      const fn = helperName(step);
      const given = step.inputs.map(say);
      return normal('📞', `call ${fn}`, `Ask the helper “${fn}” to do a job${given.length ? ` and hand it ${and(given)}` : ''}.`, [
        ...step.inputs.map(inputTile),
        { kind: 'op', text: '→' },
        { kind: 'helper', name: fn },
      ]);
    }
    case 'enter': {
      const fn = step.frames[step.frames.length - 1]?.name ?? 'the helper';
      const tiles: StoryTile[] = [];
      step.inputs.forEach((i, n) => {
        if (n > 0) tiles.push({ kind: 'op', text: ' ' });
        tiles.push(valueTile(i.value), { kind: 'op', text: '→' }, { kind: 'box', name: i.name ?? i.label });
      });
      return normal('🚪', `${fn} starts`, step.inputs.length ? `The helper “${fn}” starts. It puts what it was given into its own boxes.` : `The helper “${fn}” starts.`, tiles);
    }
    case 'return': {
      const fn = step.frames[step.frames.length - 1]?.name ?? 'helper';
      if (!out || out.t === 'none') return normal('🎁', 'done', `The helper “${fn}” is finished. It has no answer to send back.`, []);
      return normal('🎁', 'answer', `The helper “${fn}” is finished! It sends back the answer ${short(out)}.`, [resultTile(out), { kind: 'op', text: '↩' }]);
    }
    case 'method': {
      const receiver = a;
      const m = /\.(\w+)\(\)/.exec(step.title)?.[1];
      if (!out || !receiver) return normal('🔧', m ?? 'tool', step.title, []);
      const name = nameOf(receiver);
      const sayM: Record<string, string> = {
        to_numpy: `Turn the pandas column “${name}” into a plain list of numbers.`,
        sum: `Add up everything in “${name}”.`,
        mean: `Find the average of “${name}”.`,
        max: `Find the biggest number in “${name}”.`,
        min: `Find the smallest number in “${name}”.`,
        tolist: `Turn “${name}” into a Python list.`,
      };
      return normal('🔧', METHOD_LABELS[m ?? ''] ?? (m ?? 'tool'), sayM[m ?? ''] ?? `Use .${m}() on “${name}”.`, [valueTile(receiver.value, name), { kind: 'op', text: '→' }, resultTile(out)]);
    }
    case 'index': {
      const container = a;
      const index = b;
      if (!container || !index || !out) return normal('🔍', 'pick', 'Pick something from a list.', []);
      if (container.value.t === 'dataframe' && index.value.t === 'str') {
        const col = index.value.v;
        return normal('🔍', `column ${col}`, `Take the column “${col}” out of the table.`, [
          { kind: 'table', ...tablePreview(container.value, 3), caption: nameOf(container), highlight: col, ...(container.fromVariable ? { source: container.fromVariable } : {}) },
          { kind: 'op', text: `["${col}"]` },
          { kind: 'op', text: '=' },
          resultTile(out),
        ]);
      }
      const items = elementsOf(container.value);
      const spot = step.selectedIndex ?? 0;
      const who = step.title.includes('.iloc') ? nameOf({ ...container, label: container.label.replace(/\.iloc$/, '') }) : nameOf(container);
      const listTile: StoryTile = items
        ? { kind: 'list', items: items.slice(0, MAX_LIST).map(elementDisplay), selected: spot < MAX_LIST ? spot : null, caption: who }
        : valueTile(container.value, who);
      return normal('🔍', `spot ${short(index.value)}`, `Look in “${who}” at spot ${short(index.value)} (spots are counted 0, 1, 2…). It holds ${short(out)}.`, [
        listTile,
        { kind: 'op', text: `[${short(index.value)}]` },
        { kind: 'op', text: '=' },
        resultTile(out),
      ]);
    }
    case 'decision': {
      const taken = step.target?.kind === 'branch' && step.target.taken;
      if (!a) return normal('🔀', 'else', 'None of the questions were true, so do the “else” part.', [{ kind: 'result', text: 'else' }]);
      return normal('🔀', taken ? 'yes' : 'no', `Is “${a.label}” true? ${taken ? 'Yes — so do the part inside.' : 'No — so skip that part.'}`, [
        { kind: 'value', text: a.label },
        { kind: 'op', text: '?' },
        { kind: 'result', text: taken ? 'Yes' : 'No' },
      ]);
    }
    case 'loop': {
      if (step.title === 'Loop finished') return normal('🏁', 'done', 'Every item has had its turn. The loop is finished.', []);
      const names = step.target?.kind === 'variable' ? step.target.names : [];
      const items = a ? elementsOf(a.value) : null;
      const spot = step.selectedIndex;
      return normal('🔁', `item ${(spot ?? 0) + 1}`, `${step.title}: take the next item, ${out ? short(out) : ''}, and put it in “${names.join(', ')}”.`, [
        items ? { kind: 'list', items: items.slice(0, MAX_LIST).map(elementDisplay), selected: spot !== null && spot < MAX_LIST ? spot : null, caption: a ? nameOf(a) : undefined } : { kind: 'value', text: out ? short(out) : '' },
        { kind: 'op', text: '→' },
        ...names.map((n): StoryTile => ({ kind: 'box', name: n })),
      ]);
    }
    case 'error': {
      const msg = step.explanation.what.replace(/^The simulated operation raises /, '');
      const bounds = /index (-?\d+) is out of bounds for axis 0 with size (\d+)/.exec(msg);
      let headline = `Uh-oh! The program stops: ${msg}`;
      if (bounds) headline = `Uh-oh! There is no spot ${bounds[1]}. The list only has ${bounds[2]} spots (0 to ${Number(bounds[2]) - 1}).`;
      else if (msg.startsWith('ZeroDivisionError')) headline = 'Uh-oh! You cannot divide by zero, so the program stops.';
      else if (msg.startsWith('NameError')) headline = `Uh-oh! The program asks for a box that does not exist: ${msg.replace('NameError: ', '')}.`;
      return { icon: '⚠️', label: bounds ? `no spot ${bounds[1]}` : 'error', headline, tiles: bounds ? [{ kind: 'op', text: `[${bounds[1]}]` }, { kind: 'op', text: '✗' }] : [], tone: 'error' };
    }
    case 'unsupported':
      return { icon: '🚧', label: 'stops here', headline: 'This part is too tricky for the simulator, so it stops here. The code itself is still there to read.', tiles: [], tone: 'stop' };
  }
}
