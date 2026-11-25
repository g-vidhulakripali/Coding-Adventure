import { bindingOf } from '../analysis/python/callIndex';
import type { FileAnalysis } from '../analysis/python/fileAnalysis';
import { DISTRIBUTION, PACKAGES, STDLIB, stdlibDocs, stdlibPurpose } from './catalogue';
import { normalise, type Requirement } from './manifests';

export type LibraryKind = 'builtin' | 'stdlib' | 'third-party' | 'internal';

export interface LibraryUse {
  readonly name: string;
  readonly places: ReadonlyArray<{ readonly path: string; readonly line: number }>;
}

export interface Library {
  readonly kind: LibraryKind;
  /** Import name, or the project file for internal modules. */
  readonly name: string;
  /** Package to install, when it differs or is known. */
  readonly distribution: string | null;
  readonly aliases: readonly string[];
  readonly imports: ReadonlyArray<{ readonly path: string; readonly line: number }>;
  readonly uses: readonly LibraryUse[];
  /** Null when the catalogue does not know it. */
  readonly purpose: string | null;
  readonly docs: string | null;
  /** True when `docs` is for exactly the version the project asks for. */
  readonly docsForVersion: boolean;
  readonly requirements: readonly Requirement[];
}

/** Groups everything the code imports or uses, by library. */
export function findLibraries(files: ReadonlyMap<string, FileAnalysis>, requirements: readonly Requirement[]): Library[] {
  const has = { has: (p: string) => files.has(p) };
  type Entry = { kind: LibraryKind; name: string; aliases: Set<string>; imports: Array<{ path: string; line: number }>; uses: Map<string, Array<{ path: string; line: number }>> };
  const all = new Map<string, Entry>();
  const entry = (kind: LibraryKind, name: string): Entry => {
    const key = `${kind}:${name}`;
    let e = all.get(key);
    if (!e) all.set(key, (e = { kind, name, aliases: new Set(), imports: [], uses: new Map() }));
    return e;
  };
  const addUse = (e: Entry, name: string, place: { path: string; line: number }) => {
    const list = e.uses.get(name);
    if (list) list.push(place);
    else e.uses.set(name, [place]);
  };

  for (const f of files.values()) {
    /** local name → library entry and the part of the dotted name it stands for */
    const locals = new Map<string, { e: Entry; prefix: string }>();
    for (const i of f.calls.imports) {
      const place = { path: f.path, line: i.line };
      const b = bindingOf(i, f.path, has);
      if (b.kind === 'library') {
        const module = i.module ?? i.name ?? '';
        const root = module.split('.')[0]!;
        // A relative import that leads nowhere belongs to this project, not to a library.
        if (i.level > 0 || !root) continue;
        const e = entry(STDLIB.has(root) ? 'stdlib' : 'third-party', root);
        e.imports.push(place);
        if (i.name === null) {
          if (i.hasAlias) e.aliases.add(`${i.module} as ${i.local}`);
          locals.set(i.local, { e, prefix: i.hasAlias ? i.module! : i.local });
        } else {
          if (i.hasAlias) e.aliases.add(`${i.module}.${i.name} as ${i.local}`);
          addUse(e, `${i.module}.${i.name}`, place);
          locals.set(i.local, { e, prefix: `${i.module}.${i.name}` });
        }
      } else {
        const e = entry('internal', b.kind === 'project-symbol' ? (b.submodule ?? b.path) : b.path);
        e.imports.push(place);
        if (i.hasAlias) e.aliases.add(i.local);
        locals.set(i.local, { e, prefix: i.name ?? '' });
      }
    }
    for (const u of f.uses) {
      const [root, ...rest] = u.name.split('.') as [string, ...string[]];
      const l = locals.get(root);
      if (!l || (l.e.kind !== 'internal' && rest.length === 0)) continue;
      const name = [l.prefix, ...rest].filter(Boolean).join('.');
      if (name) addUse(l.e, name, { path: f.path, line: u.span.startLine });
    }
    for (const c of f.calls.calls) {
      // Built-in functions: plain names that nothing in the file defines or imports.
      if (!c.name || locals.has(c.name) || !BUILTIN.has(c.name) || f.calls.definitions.some((d) => d.name === c.name)) continue;
      addUse(entry('builtin', 'Python'), c.name, { path: f.path, line: c.span.startLine });
    }
  }

  const byName = new Map<string, Requirement[]>();
  for (const r of requirements) {
    const list = byName.get(r.name);
    if (list) list.push(r);
    else byName.set(r.name, [r]);
  }
  const order: LibraryKind[] = ['third-party', 'stdlib', 'builtin', 'internal'];
  return [...all.values()]
    .map((e): Library => {
      const distribution = e.kind === 'third-party' ? normalise(DISTRIBUTION[e.name] ?? e.name) : null;
      const info = distribution ? PACKAGES[distribution] : undefined;
      const reqs = distribution ? (byName.get(distribution) ?? []) : [];
      const exact = reqs.map((r) => /^={2,3}(\d+)\.(\d+)/.exec(r.spec)).find(Boolean);
      const versioned = exact && info?.versioned ? info.versioned(exact[1]!, exact[2]!) : null;
      return {
        kind: e.kind,
        name: e.name,
        distribution,
        aliases: [...e.aliases].sort(),
        imports: e.imports,
        uses: [...e.uses].map(([name, places]) => ({ name, places })).sort((a, b) => b.places.length - a.places.length),
        purpose: e.kind === 'builtin' ? 'Always available in Python.' : e.kind === 'stdlib' ? stdlibPurpose(e.name) : e.kind === 'internal' ? null : (info?.purpose ?? null),
        docs: e.kind === 'builtin' ? 'https://docs.python.org/3/library/functions.html' : e.kind === 'stdlib' ? stdlibDocs(e.name) : (versioned ?? info?.docs ?? null),
        docsForVersion: versioned !== null,
        requirements: reqs,
      };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/** Packages that are asked for but never imported by the analysed code. */
export function unusedRequirements(libraries: readonly Library[], requirements: readonly Requirement[]): Requirement[] {
  const used = new Set(libraries.flatMap((l) => (l.distribution ? [l.distribution] : [])));
  return requirements.filter((r) => !r.name.startsWith('npm:') && !used.has(r.name));
}

const BUILTIN: ReadonlySet<string> = new Set('abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip'.split(' '));
