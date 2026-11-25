import { parsePythonModule, type Expr } from '../parser/python/ast';
import { fromJson, fromToml, fromYaml, get, texts, type Structured } from '../structured/structured';

/** A package a project file asks for. */
export interface Requirement {
  /** Normalised package name, e.g. `scikit-learn`. */
  readonly name: string;
  /** Version condition as written, e.g. `>=1.2,<2`; empty when none is given. */
  readonly spec: string;
  readonly file: string;
  readonly line: number | null;
}

/** Package names are compared this way (PEP 503). */
export const normalise = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** One requirement line, e.g. `pandas[excel]>=2 ; python_version > "3.8"`. Null for options and comments. */
export function parseRequirement(text: string): { name: string; spec: string } | null {
  const line = text.replace(/\s#.*$/, '').trim();
  if (!line || line.startsWith('#') || line.startsWith('-')) return null;
  const main = line.split(';')[0]!.trim();
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/.exec(main);
  if (!m) return null;
  const rest = m[3]!.trim().replace(/^\((.*)\)$/, '$1');
  if (rest && !/^(@|[<>=!~])/.test(rest)) return null;
  return { name: normalise(m[1]!), spec: rest.startsWith('@') ? rest : rest.replace(/\s+/g, '') };
}

export interface ManifestResult {
  readonly requirements: readonly Requirement[];
  /** Why a file could not be read, if so. */
  readonly problem: string | null;
}

export async function readManifest(path: string, text: string): Promise<ManifestResult> {
  const name = path.split('/').pop()!.toLowerCase();
  const out: Requirement[] = [];
  const add = (raw: string, line: number | null = null) => {
    const r = parseRequirement(raw);
    if (r && r.name !== 'python') out.push({ ...r, file: path, line });
  };
  const lineOf = (needle: string) => {
    const i = text.split('\n').findIndex((l) => l.includes(needle));
    return i < 0 ? null : i + 1;
  };
  const table = (s: Structured | undefined) => {
    if (s?.kind !== 'object') return;
    for (const [k, v] of s.entries) {
      const version = v.kind === 'scalar' ? v.text : (get(v, 'version')?.kind === 'scalar' ? (get(v, 'version') as { text: string }).text : '');
      if (normalise(k) !== 'python') out.push({ name: normalise(k), spec: version === '*' ? '' : /^\d/.test(version) ? `==${version}` : version, file: path, line: lineOf(k) });
    }
  };
  try {
    if (name === 'pyproject.toml') {
      const t = fromToml(text);
      for (const d of texts(get(get(t, 'project'), 'dependencies'))) add(d, lineOf(d));
      const optional = get(get(t, 'project'), 'optional-dependencies');
      if (optional?.kind === 'object') for (const [, v] of optional.entries) for (const d of texts(v)) add(d, lineOf(d));
      const groups = get(t, 'dependency-groups');
      if (groups?.kind === 'object') for (const [, v] of groups.entries) for (const d of texts(v)) add(d, lineOf(d));
      const poetry = get(get(t, 'tool'), 'poetry');
      table(get(poetry, 'dependencies'));
      table(get(poetry, 'dev-dependencies'));
    } else if (name === 'pipfile') {
      const t = fromToml(text);
      table(get(t, 'packages'));
      table(get(t, 'dev-packages'));
    } else if (name === 'environment.yml' || name === 'environment.yaml') {
      const deps = get(await fromYaml(text), 'dependencies');
      if (deps?.kind === 'array') {
        for (const d of deps.items) {
          if (d.kind === 'scalar') {
            const m = /^([\w.-]+)\s*(?:=+\s*([\w.*]+))?/.exec(d.text.replace(/^[\w-]+::/, ''));
            if (m && normalise(m[1]!) !== 'python' && normalise(m[1]!) !== 'pip') out.push({ name: normalise(m[1]!), spec: m[2] ? `==${m[2]}` : /[<>]/.test(d.text) ? d.text.slice(m[1]!.length).trim() : '', file: path, line: lineOf(d.text) });
          } else for (const p of texts(get(d, 'pip'))) add(p, lineOf(p));
        }
      }
    } else if (name === 'package.json') {
      const j = fromJson(text);
      for (const part of ['dependencies', 'devDependencies']) {
        const deps = get(j, part);
        if (deps?.kind === 'object') for (const [k, v] of deps.entries) out.push({ name: `npm:${k}`, spec: v.kind === 'scalar' ? v.text : '', file: path, line: lineOf(`"${k}"`) });
      }
    } else if (name === 'setup.py') {
      const visit = (n: unknown): void => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          n.forEach(visit);
          return;
        }
        const e = n as Expr;
        if (e.type === 'Call') for (const k of e.keywords) if ((k.name === 'install_requires' || k.name === 'tests_require') && k.value.type === 'List') for (const x of k.value.elts) if (x.type === 'Constant' && x.kind === 'str') add(String(x.value), lineOf(String(x.value)));
        for (const [k, x] of Object.entries(e)) if (k !== 'span') visit(x);
      };
      visit(parsePythonModule(text).body);
    } else if (name === 'setup.cfg') {
      let inside = false;
      text.split('\n').forEach((l, i) => {
        const start = /^(install_requires)\s*=\s*(.*)$/.exec(l);
        if (start) {
          inside = true;
          if (start[2]) add(start[2], i + 1);
        } else if (inside && /^\s+\S/.test(l)) add(l, i + 1);
        else if (l.trim()) inside = false;
      });
    } else if (/^(requirements|constraints)[-_.\w]*\.txt$/.test(name)) {
      text.split('\n').forEach((l, i) => add(l, i + 1));
    } else return { requirements: [], problem: 'This kind of project file is not read for packages.' };
    return { requirements: out, problem: null };
  } catch (err) {
    return { requirements: out, problem: err instanceof Error ? err.message : String(err) };
  }
}
