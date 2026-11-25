import { pythonLanguage } from '@codemirror/lang-python';
import { findModels, type ModelUse } from '../../models/detect';
import { computeLineStarts, parsePythonModule, positionAt, type Expr, type Module, type Stmt } from '../../parser/python/ast';
import { sortByLine, type ParserCheck, type Structure } from '../../parser/python/treeSitter';
import { findScenarios, type ScenarioOption } from '../../simulation/scenarios';
import type { SourceSpan } from '../../source-mapping/types';
import { extractCalls, type FileCalls } from './callIndex';
import { coverageOf, type Coverage } from './coverage';

/**
 * Everything learned from one Python file. Plain data that does not depend on any
 * other file, so it can be computed in a worker and stored: a file is analysed
 * again only when it or the analysis changes.
 */

/** Raise this whenever the shape or the meaning of the stored analysis changes. */
export const ANALYSIS_VERSION = 1;

/** A use of a name, for "where is this used" and for jumping to definitions. */
export interface NameUse {
  /** Dotted path as written, e.g. `K.LIMIT` or `helper`. */
  readonly name: string;
  readonly span: SourceSpan;
}

/** A text in the code that may be the path of a file. */
export interface PathText {
  readonly value: string;
  readonly line: number;
  /** False when the text is only a part of a path built at runtime. */
  readonly whole: boolean;
}

export interface FileAnalysis {
  readonly version: number;
  readonly path: string;
  readonly lines: number;
  /** Length of the analysed text, to notice a changed file. */
  readonly sourceLength: number;
  readonly calls: FileCalls;
  /** Names assigned at the top of the file → line. */
  readonly constants: ReadonlyArray<{ readonly name: string; readonly line: number }>;
  readonly uses: readonly NameUse[];
  readonly paths: readonly PathText[];
  readonly coverage: Coverage;
  readonly scenarios: readonly ScenarioOption[];
  readonly models: readonly ModelUse[];
  /** What the main parser found, for the comparison with Tree-sitter. */
  readonly structure: Structure;
  readonly check: ParserCheck | null;
}

export function analysePythonFile(path: string, source: string): FileAnalysis {
  const module = parsePythonModule(source);
  const calls = extractCalls(path, source);
  const constants: Array<{ name: string; line: number }> = [];
  const lineStarts = computeLineStarts(source);
  const seen = new Set<string>();
  const constant = (t: Expr) => {
    if (t.type === 'Tuple' || t.type === 'List') t.elts.forEach(constant);
    else if (t.type === 'Name' && !seen.has(t.id)) {
      seen.add(t.id);
      constants.push({ name: t.id, line: positionAt(lineStarts, t.span.from).line });
    }
  };
  for (const s of module.body) if (s.type === 'Assign') s.targets.forEach(constant);

  // Only names that can lead somewhere: imported ones and those defined at the top of this file.
  const roots = new Set([...calls.imports.map((i) => i.local), ...constants.map((c) => c.name), ...calls.definitions.filter((d) => d.kind !== 'module' && !d.qualname.includes('.')).map((d) => d.name)]);
  const uses: NameUse[] = [];
  const paths: PathText[] = [];
  collectNames(module, path, lineStarts, roots, uses, paths);

  return {
    version: ANALYSIS_VERSION,
    path,
    lines: lineStarts.length,
    sourceLength: source.length,
    calls,
    constants,
    uses,
    paths,
    coverage: coverageOf(module),
    scenarios: findScenarios(path, module),
    models: findModels(path, module),
    structure: lezerStructure(source),
    check: null,
  };
}

const PATH_LIKE = /\.[A-Za-z][A-Za-z0-9]{0,5}$/;

function collectNames(module: Module, path: string, lineStarts: readonly number[], roots: ReadonlySet<string>, uses: NameUse[], paths: PathText[]) {
  const starts = [...lineStarts];
  const spanOf = (from: number, to: number): SourceSpan => {
    const a = positionAt(starts, from);
    const b = positionAt(starts, to);
    return { path, startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
  };
  const visit = (n: unknown, whole: boolean): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach((x) => visit(x, whole));
      return;
    }
    const node = n as Expr | Stmt;
    switch (node.type) {
      case 'Import':
      case 'ImportFrom':
        return;
      case 'Expr':
        if (node.isDocstring) return;
        break;
      case 'Name':
        if (roots.has(node.id)) uses.push({ name: node.id, span: spanOf(node.span.from, node.span.to) });
        return;
      case 'Attribute': {
        const parts: string[] = [node.attr];
        let base: Expr = node.value;
        while (base.type === 'Attribute') {
          parts.unshift(base.attr);
          base = base.value;
        }
        if (base.type === 'Name') {
          if (roots.has(base.id)) uses.push({ name: [base.id, ...parts].join('.'), span: spanOf(node.span.from, node.span.to) });
        } else visit(base, true);
        return;
      }
      case 'Constant':
        if (node.kind === 'str') {
          const value = String(node.value);
          if (value.length < 260 && !/[\n*?<>|]/.test(value) && PATH_LIKE.test(value) && !/^https?:/.test(value) && !value.startsWith('.')) paths.push({ value, line: positionAt(starts, node.span.from).line, whole });
        }
        return;
      case 'JoinedStr':
        for (const p of node.parts) if (typeof p !== 'string') visit(p.value, true);
        {
          const last = node.parts[node.parts.length - 1];
          if (typeof last === 'string' && PATH_LIKE.test(last) && last.length < 260) paths.push({ value: last, line: positionAt(starts, node.span.from).line, whole: false });
        }
        return;
      case 'BinOp':
        visit(node.left, false);
        visit(node.right, false);
        return;
      case 'Call': {
        visit(node.func, true);
        // `os.path.join(base, "x.csv")`, `Path(a, "x.csv")`: the text is one part of a longer path.
        const joins = node.func.type === 'Attribute' ? node.func.attr === 'join' || node.func.attr === 'joinpath' : node.func.type === 'Name' && node.func.id === 'Path';
        const part = joins && node.args.length > 1;
        node.args.forEach((a) => visit(a, !part));
        node.keywords.forEach((k) => visit(k.value, true));
        return;
      }
    }
    for (const [k, x] of Object.entries(node)) if (k !== 'span' && k !== 'headerSpan' && typeof x === 'object') visit(x, whole);
  };
  visit(module.body, true);
}

function lezerStructure(source: string): Structure {
  let imports = 0;
  let errors = 0;
  let callCount = 0;
  const definitions: string[] = [];
  const lineStarts = computeLineStarts(source);
  pythonLanguage.parser.parse(source).iterate({
    enter(n) {
      if (n.type.isError) errors++;
      else if (n.name === 'ImportStatement') imports++;
      // Lezer keeps `@decorator(…)` flat; it is a call all the same.
      else if (n.name === 'CallExpression' || (n.name === 'Decorator' && n.node.getChild('ArgList'))) callCount++;
      else if (n.name === 'FunctionDefinition' || n.name === 'ClassDefinition') {
        const name = n.node.getChild('VariableName');
        definitions.push(`${n.name === 'ClassDefinition' ? 'class' : 'def'} ${name ? source.slice(name.from, name.to) : '?'}@${positionAt(lineStarts, n.from).line}`);
      }
    },
  });
  return { definitions: sortByLine(definitions), calls: callCount, imports, errors };
}
