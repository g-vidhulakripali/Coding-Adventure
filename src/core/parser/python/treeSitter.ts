import type { Language, Node, Parser } from 'web-tree-sitter';

/**
 * Tree-sitter (Python grammar, WebAssembly) as an independent second parser.
 *
 * The simulation reads the AST built from the Lezer grammar. Tree-sitter reads the
 * same file separately, and the two results are compared: definitions, calls,
 * imports and broken regions. Agreement of two unrelated parsers is evidence that
 * the structure shown is right; disagreement is reported, never hidden.
 */

export interface Structure {
  /** `kind name@line`, in file order. */
  readonly definitions: readonly string[];
  readonly calls: number;
  readonly imports: number;
  readonly errors: number;
}

export interface ParserCheck {
  readonly agree: boolean;
  /** Plain sentences, one per difference. */
  readonly differences: readonly string[];
}

export interface WasmSource {
  /** Location (or bytes) of `tree-sitter.wasm`. */
  readonly runtime: string | Uint8Array;
  readonly python: string | Uint8Array;
}

let loading: Promise<Parser> | null = null;

export function loadTreeSitter(wasm: WasmSource): Promise<Parser> {
  loading ??= (async () => {
    const lib = await import('web-tree-sitter');
    await lib.Parser.init(typeof wasm.runtime === 'string' ? { locateFile: () => wasm.runtime as string } : { wasmBinary: wasm.runtime });
    const language: Language = await lib.Language.load(wasm.python);
    const parser = new lib.Parser();
    parser.setLanguage(language);
    return parser;
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

export function treeSitterStructure(parser: Parser, source: string): Structure {
  const tree = parser.parse(source);
  if (!tree) throw new Error('Tree-sitter returned no tree.');
  const definitions: string[] = [];
  let calls = 0;
  let imports = 0;
  let errors = 0;
  // An explicit stack: deeply nested code must not overflow the call stack.
  const stack: Node[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) errors++;
    switch (node.type) {
      case 'function_definition':
      case 'class_definition': {
        const name = node.childForFieldName('name');
        definitions.push(`${node.type === 'class_definition' ? 'class' : 'def'} ${name?.text ?? '?'}@${node.startPosition.row + 1}`);
        break;
      }
      case 'call':
        calls++;
        break;
      case 'import_statement':
      case 'import_from_statement':
      case 'future_import_statement':
        imports++;
        break;
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  tree.delete();
  return { definitions: sortByLine(definitions), calls, imports, errors };
}

const lineOf = (d: string) => Number(d.slice(d.lastIndexOf('@') + 1));
export function sortByLine(definitions: readonly string[]): string[] {
  return [...definitions].sort((a, b) => lineOf(a) - lineOf(b) || a.localeCompare(b));
}

/** Compares what two parsers found. */
export function compareStructures(ours: Structure, other: Structure): ParserCheck {
  const differences: string[] = [];
  const a = new Set(ours.definitions);
  const b = new Set(other.definitions);
  for (const d of ours.definitions) if (!b.has(d)) differences.push(`Only the main parser sees \`${d.replace('@', '` in line ')}.`);
  for (const d of other.definitions) if (!a.has(d)) differences.push(`Only Tree-sitter sees \`${d.replace('@', '` in line ')}.`);
  if (ours.calls !== other.calls) differences.push(`Calls found: ${ours.calls} (main parser) and ${other.calls} (Tree-sitter).`);
  if (ours.imports !== other.imports) differences.push(`Import lines found: ${ours.imports} (main parser) and ${other.imports} (Tree-sitter).`);
  if ((ours.errors > 0) !== (other.errors > 0)) differences.push(`Broken regions: ${ours.errors} (main parser) and ${other.errors} (Tree-sitter).`);
  return { agree: differences.length === 0, differences: differences.slice(0, 20) };
}
