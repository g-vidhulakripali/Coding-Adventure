import type { SyntaxNode } from '@lezer/common';

/** A configuration or data file as a tree, for viewing. Values are shown as written. */
export type Structured =
  | { readonly kind: 'object'; readonly entries: ReadonlyArray<readonly [string, Structured]> }
  | { readonly kind: 'array'; readonly items: readonly Structured[] }
  | { readonly kind: 'scalar'; readonly text: string; readonly type: 'text' | 'number' | 'yes/no' | 'nothing' | 'other' };

const MAX_NODES = 20_000;

export function fromJson(text: string): Structured {
  const data: unknown = JSON.parse(text);
  let left = MAX_NODES;
  const convert = (v: unknown): Structured => {
    if (left-- <= 0) return { kind: 'scalar', text: '… (not shown: the file is very large)', type: 'other' };
    if (Array.isArray(v)) return { kind: 'array', items: v.slice(0, 2000).map(convert) };
    if (v && typeof v === 'object') return { kind: 'object', entries: Object.entries(v).map(([k, x]) => [k, convert(x)] as const) };
    if (typeof v === 'string') return { kind: 'scalar', text: v, type: 'text' };
    if (typeof v === 'number') return { kind: 'scalar', text: String(v), type: 'number' };
    if (typeof v === 'boolean') return { kind: 'scalar', text: String(v), type: 'yes/no' };
    return { kind: 'scalar', text: 'null', type: 'nothing' };
  };
  return convert(data);
}

/** YAML through the Lezer grammar. Anchors, tags and multi-line texts are shown as written. */
export async function fromYaml(text: string): Promise<Structured> {
  const { yamlLanguage } = await import('@codemirror/lang-yaml');
  const tree = yamlLanguage.parser.parse(text);
  let broken = false;
  tree.iterate({
    enter(n) {
      if (n.type.isError) broken = true;
    },
  });
  if (broken) throw new Error('This YAML could not be read completely. See the source instead.');
  let left = MAX_NODES;
  const raw = (n: SyntaxNode) => text.slice(n.from, n.to);
  const kids = (n: SyntaxNode): SyntaxNode[] => {
    const out: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name !== 'Comment') out.push(c);
    return out;
  };
  const scalar = (value: string): Structured => {
    const quoted = /^(["'])([^]*)\1$/.exec(value);
    if (quoted) return { kind: 'scalar', text: quoted[1] === "'" ? quoted[2]!.replace(/''/g, "'") : quoted[2]!, type: 'text' };
    const type = /^[-+]?(\d[\d_]*\.?\d*([eE][-+]?\d+)?|\.\d+)$/.test(value) ? 'number' : /^(true|false)$/i.test(value) ? 'yes/no' : /^(null|~|)$/i.test(value) ? 'nothing' : 'text';
    return { kind: 'scalar', text: value, type };
  };
  const convert = (n: SyntaxNode): Structured => {
    if (left-- <= 0) return { kind: 'scalar', text: '… (not shown: the file is very large)', type: 'other' };
    switch (n.name) {
      case 'Stream': {
        const docs = kids(n).filter((c) => c.name === 'Document');
        return docs.length === 1 ? convert(docs[0]!) : { kind: 'array', items: docs.map(convert) };
      }
      case 'Document': {
        const body = kids(n).find((c) => !/^(Directive|DirectiveEnd|DocEnd)/.test(c.name));
        return body ? convert(body) : { kind: 'scalar', text: '', type: 'nothing' };
      }
      case 'BlockMapping':
      case 'FlowMapping':
        return {
          kind: 'object',
          entries: kids(n)
            .filter((c) => c.name === 'Pair')
            .map((p) => {
              const parts = kids(p);
              const key = parts.find((c) => c.name === 'Key');
              const colon = parts.findIndex((c) => c.name === ':');
              const value = colon >= 0 ? parts.slice(colon + 1)[0] : undefined;
              return [key ? raw(key).replace(/^(["'])([^]*)\1$/, '$2') : '', value ? convert(value) : { kind: 'scalar', text: '', type: 'nothing' }] as const;
            }),
        };
      case 'BlockSequence':
      case 'FlowSequence':
        return { kind: 'array', items: kids(n).flatMap((c) => (c.name === 'Item' ? kids(c).filter((x) => x.name !== '-').map(convert) : [])) };
      case 'Tagged':
      case 'Anchored':
        return { kind: 'scalar', text: raw(n), type: 'other' };
      default:
        return scalar(raw(n));
    }
  };
  return convert(tree.topNode);
}

export function get(s: Structured | undefined, key: string): Structured | undefined {
  return s?.kind === 'object' ? s.entries.find(([k]) => k === key)?.[1] : undefined;
}

export function texts(s: Structured | undefined): string[] {
  return s?.kind === 'array' ? s.items.flatMap((i) => (i.kind === 'scalar' ? [i.text] : [])) : [];
}

/**
 * The part of TOML used by Python project files: tables, arrays of tables, texts,
 * numbers, arrays and inline tables. Anything else raises an error instead of
 * being guessed.
 */
export function fromToml(source: string): Structured {
  type Obj = Map<string, unknown>;
  const root: Obj = new Map();
  let at = 0;
  let table: Obj = root;
  const s = source.replace(/\r\n?/g, '\n');
  const fail = (why: string): never => {
    throw new Error(`Line ${s.slice(0, at).split('\n').length}: ${why}`);
  };
  const space = (newlines: boolean) => {
    for (;;) {
      const c = s[at];
      if (c === ' ' || c === '\t' || (newlines && c === '\n')) at++;
      else if (c === '#') while (at < s.length && s[at] !== '\n') at++;
      else return;
    }
  };
  const str = (): string => {
    const q = s[at]!;
    if (s.startsWith(q.repeat(3), at)) {
      const end = s.indexOf(q.repeat(3), at + 3);
      if (end < 0) fail('a text is not closed');
      const v = s.slice(at + 3, end).replace(/^\n/, '');
      at = end + 3;
      return v;
    }
    let v = '';
    for (at++; ; at++) {
      const c = s[at];
      if (c === undefined || c === '\n') fail('a text is not closed');
      if (c === q) break;
      if (c === '\\' && q === '"') {
        const n = s[++at];
        v += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '');
      } else v += c;
    }
    at++;
    return v;
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      space(false);
      if (s[at] === '"' || s[at] === "'") parts.push(str());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(at, at + 200));
        if (!m) fail('a name is expected here');
        parts.push(m![0]);
        at += m![0].length;
      }
      space(false);
      if (s[at] !== '.') return parts;
      at++;
    }
  };
  const into = (from: Obj, parts: readonly string[]): Obj => {
    let o = from;
    for (const p of parts) {
      let next = o.get(p);
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!(next instanceof Map)) {
        next = new Map();
        o.set(p, next);
      }
      o = next as Obj;
    }
    return o;
  };
  const value = (): unknown => {
    space(false);
    const c = s[at];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      at++;
      const out: unknown[] = [];
      for (;;) {
        space(true);
        if (s[at] === ']') {
          at++;
          return out;
        }
        out.push(value());
        space(true);
        if (s[at] === ',') at++;
        else if (s[at] !== ']') fail('"," or "]" is expected');
      }
    }
    if (c === '{') {
      at++;
      const o: Obj = new Map();
      for (;;) {
        space(true);
        if (s[at] === '}') {
          at++;
          return o;
        }
        const k = key();
        space(false);
        if (s[at] !== '=') fail('"=" is expected');
        at++;
        into(o, k.slice(0, -1)).set(k[k.length - 1]!, value());
        space(true);
        if (s[at] === ',') at++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(at, at + 400));
    if (!m) fail('a value is expected');
    at += m![0].length;
    return { bare: m![0] };
  };
  for (;;) {
    space(true);
    if (at >= s.length) break;
    if (s[at] === '[') {
      const many = s[at + 1] === '[';
      at += many ? 2 : 1;
      const k = key();
      if (!s.startsWith(many ? ']]' : ']', at)) fail('"]" is expected');
      at += many ? 2 : 1;
      if (many) {
        const parent = into(root, k.slice(0, -1));
        const last = k[k.length - 1]!;
        const arr = parent.get(last);
        table = new Map();
        if (Array.isArray(arr)) arr.push(table);
        else parent.set(last, [table]);
      } else table = into(root, k);
    } else {
      const k = key();
      if (s[at] !== '=') fail('"=" is expected');
      at++;
      into(table, k.slice(0, -1)).set(k[k.length - 1]!, value());
      space(false);
      if (at < s.length && s[at] !== '\n') fail('the line should end here');
    }
  }
  const convert = (v: unknown): Structured => {
    if (v instanceof Map) return { kind: 'object', entries: [...v].map(([k, x]) => [String(k), convert(x)] as const) };
    if (Array.isArray(v)) return { kind: 'array', items: v.map(convert) };
    if (typeof v === 'string') return { kind: 'scalar', text: v, type: 'text' };
    const bare = (v as { bare: string }).bare;
    return { kind: 'scalar', text: bare, type: /^(true|false)$/.test(bare) ? 'yes/no' : /^[-+]?[\d_.]+(e[-+]?\d+)?$/i.test(bare) ? 'number' : 'other' };
  };
  return convert(root);
}
