import { bindingOf, linkCalls, type CallIndex, type ImportFact } from './callIndex';
import type { FileAnalysis, NameUse } from './fileAnalysis';

/**
 * Connects the files of a project: what a name refers to, and where a definition
 * is used. Follows imports and top-level definitions only. A name that Python
 * would look up at runtime (an attribute of an object, a local variable) is not
 * guessed.
 */

export interface Target {
  readonly path: string;
  readonly line: number;
  /** Qualified name in that file; `<module>` for a file itself. */
  readonly name: string;
  readonly kind: 'function' | 'method' | 'class' | 'constant' | 'file';
}

export interface ResolvedUse {
  readonly use: NameUse;
  readonly target: Target;
  /** How much of the dotted name the target covers (`K.LIMIT` → 2, `cls.make` → …). */
  readonly covers: number;
}

export const targetKey = (t: { path: string; name: string }) => `${t.path}::${t.name}`;

interface FileNames {
  readonly imports: Map<string, ImportFact>;
  readonly targets: Map<string, Target>;
}

export class ProjectIndex {
  readonly callIndex: CallIndex;
  private readonly names = new Map<string, FileNames>();
  private readonly usesByTarget = new Map<string, ResolvedUse[]>();
  private readonly usesByFile = new Map<string, ResolvedUse[]>();

  constructor(readonly files: ReadonlyMap<string, FileAnalysis>) {
    this.callIndex = linkCalls([...files.values()].map((f) => f.calls));
    for (const f of files.values()) {
      const targets = new Map<string, Target>();
      for (const c of f.constants) targets.set(c.name, { path: f.path, line: c.line, name: c.name, kind: 'constant' });
      for (const d of f.calls.definitions) if (d.kind !== 'module') targets.set(d.qualname, { path: f.path, line: d.span.startLine, name: d.qualname, kind: d.kind });
      this.names.set(f.path, { imports: new Map(f.calls.imports.map((i) => [i.local, i])), targets });
    }
    for (const f of files.values()) {
      const list: ResolvedUse[] = [];
      for (const use of f.uses) {
        const found = this.resolve(f.path, use.name);
        if (!found) continue;
        const resolved = { use, ...found };
        list.push(resolved);
        // The line that defines a name is not a use of it.
        if (found.target.path === f.path && found.target.line === use.span.startLine) continue;
        const key = targetKey(found.target);
        const all = this.usesByTarget.get(key);
        if (all) all.push(resolved);
        else this.usesByTarget.set(key, [resolved]);
      }
      this.usesByFile.set(f.path, list);
    }
  }

  /** What a dotted name written in a file refers to, or null when that is not certain. */
  resolve(path: string, dotted: string): { target: Target; covers: number } | null {
    const file = this.names.get(path);
    if (!file) return null;
    const parts = dotted.split('.');
    const own = this.longest(path, parts, 0);
    if (own) return own;
    const imported = file.imports.get(parts[0]!);
    if (!imported) return null;
    const binding = bindingOf(imported, path, { has: (p) => this.files.has(p) });
    if (binding.kind === 'library') return null;
    if (binding.kind === 'project-symbol') {
      const found = this.longest(binding.path, [binding.symbol, ...parts.slice(1)], 0);
      if (found) return found;
      if (!binding.submodule) return null;
      return this.inModule(binding.submodule, parts);
    }
    // `import a.b.c` without `as`: the written name spells the module path.
    if (!imported.hasAlias && imported.name === null && imported.module!.includes('.')) {
      const spelled = imported.module!.split('.');
      if (spelled.some((s, i) => parts[i] !== s)) return null;
      const found = this.longest(binding.path, parts, spelled.length);
      return found ?? { target: this.fileTarget(binding.path), covers: spelled.length };
    }
    return this.inModule(binding.path, parts);
  }

  private inModule(path: string, parts: readonly string[]) {
    return this.longest(path, parts, 1) ?? (parts.length === 1 ? { target: this.fileTarget(path), covers: 1 } : null);
  }

  private fileTarget(path: string): Target {
    return { path, line: 1, name: '<module>', kind: 'file' };
  }

  /** The longest prefix of `parts` (after `skip`) that is defined at the top of `path`. */
  private longest(path: string, parts: readonly string[], skip: number) {
    const targets = this.names.get(path)?.targets;
    if (!targets) return null;
    for (let end = parts.length; end > skip; end--) {
      const target = targets.get(parts.slice(skip, end).join('.'));
      if (target) return { target, covers: end };
    }
    return null;
  }

  usesOf(target: { path: string; name: string }): readonly ResolvedUse[] {
    return this.usesByTarget.get(targetKey(target)) ?? [];
  }

  usesIn(path: string): readonly ResolvedUse[] {
    return this.usesByFile.get(path) ?? [];
  }

  /** What the code at one place of a file leads to: a name, a method call such as `self.x()`, or an import. */
  at(path: string, line: number, column: number): { target: Target; evidence: 'static' | 'inferred' } | null {
    const inside = (s: NameUse['span']) => (line > s.startLine || (line === s.startLine && column >= (s.startColumn ?? 0))) && (line < s.endLine || (line === s.endLine && column <= (s.endColumn ?? 0)));
    const hit = this.usesIn(path).find((u) => inside(u.use.span));
    if (hit) return { target: hit.target, evidence: 'static' };
    const call = this.callIndex.calls
      .filter((c) => c.span.path === path && inside(c.span) && column - (c.span.startColumn ?? 0) <= c.callee.length && line === c.span.startLine)
      .sort((a, b) => b.callee.length - a.callee.length)
      .find((c) => c.target.kind === 'internal');
    if (call?.target.kind === 'internal') {
      const id = call.target.id;
      const def = this.callIndex.definitions.find((d) => d.id === id);
      if (def) return { target: { path: def.path, line: def.span.startLine, name: def.qualname, kind: def.kind === 'module' ? 'file' : def.kind }, evidence: call.target.evidence };
    }
    return null;
  }

  /** The definition on this line (its own header), for "used by". */
  definitionAt(path: string, line: number): Target | null {
    const file = this.files.get(path);
    if (!file) return null;
    const def = file.calls.definitions.find((d) => d.kind !== 'module' && d.span.startLine <= line && line <= d.span.endLine);
    if (def) return { path, line: def.span.startLine, name: def.qualname, kind: def.kind as Target['kind'] };
    const constant = file.constants.find((c) => c.line === line);
    return constant ? { path, line, name: constant.name, kind: 'constant' } : null;
  }
}
