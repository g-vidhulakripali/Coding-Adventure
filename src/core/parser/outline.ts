import { pythonLanguage } from '@codemirror/lang-python';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { LineRange } from '../source-mapping/types';

/**
 * File outline (functions, classes, methods) for code navigation.
 *
 * Phase 1 implementation: uses the Lezer Python grammar that already ships with
 * the CodeMirror Python mode. It is a real incremental LR parser with error
 * recovery — not regular expressions — and is cheap because the viewer loads it
 * anyway. Phase 3 introduces the full analysis parser (Tree-sitter Python WASM,
 * pending evaluation) behind the parser abstraction; the outline will then come
 * from that analysis and this module will remain as a lightweight fallback.
 */

export type OutlineKind = 'class' | 'function' | 'method';

export interface OutlineSymbol {
  readonly kind: OutlineKind;
  readonly name: string;
  readonly isAsync: boolean;
  readonly decorated: boolean;
  /** Line of the `def` / `class` keyword. */
  readonly line: number;
  /** Full extent of the definition, from its first decorator to the end of its body. */
  readonly range: LineRange;
  readonly children: readonly OutlineSymbol[];
}

export interface FileOutline {
  readonly symbols: readonly OutlineSymbol[];
  /** Number of regions the parser had to recover from. When > 0, the outline may be incomplete. */
  readonly syntaxErrorCount: number;
}

export function extractPythonOutline(source: string): FileOutline {
  const tree: Tree = pythonLanguage.parser.parse(source);
  const lineStarts = computeLineStarts(source);
  const lineAt = (pos: number) => lineOf(lineStarts, pos);

  let syntaxErrorCount = 0;
  tree.iterate({
    enter(node) {
      if (node.type.isError) syntaxErrorCount++;
    },
  });

  const collect = (parent: SyntaxNode, insideClass: boolean): OutlineSymbol[] => {
    const result: OutlineSymbol[] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      let definition: SyntaxNode | null = null;
      let outer: SyntaxNode = child;
      if (child.name === 'FunctionDefinition' || child.name === 'ClassDefinition') {
        definition = child;
      } else if (child.name === 'DecoratedStatement') {
        definition = child.getChild('FunctionDefinition') ?? child.getChild('ClassDefinition');
        outer = child;
      }

      if (definition) {
        const isClass = definition.name === 'ClassDefinition';
        const nameNode = definition.getChild('VariableName');
        const keyword = definition.getChild(isClass ? 'class' : 'def') ?? definition;
        const body = definition.getChild('Body');
        result.push({
          kind: isClass ? 'class' : insideClass ? 'method' : 'function',
          name: nameNode ? source.slice(nameNode.from, nameNode.to) : '(unnamed)',
          isAsync: definition.getChild('async') !== null,
          decorated: outer !== definition,
          line: lineAt(keyword.from),
          range: { startLine: lineAt(outer.from), endLine: lineAt(Math.max(outer.from, trimEnd(source, outer.to))) },
          children: body ? collect(body, isClass) : [],
        });
      } else if (child.name !== 'Body') {
        // Definitions can be nested inside if/try/with/for blocks at module or class level.
        const nested = child.getChild('Body') ? collectFromBlocks(child, insideClass) : [];
        result.push(...nested);
      }
    }
    return result;
  };

  const collectFromBlocks = (node: SyntaxNode, insideClass: boolean): OutlineSymbol[] => {
    const result: OutlineSymbol[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'Body') result.push(...collect(child, insideClass));
    }
    return result;
  };

  return { symbols: collect(tree.topNode, false), syntaxErrorCount };
}

/** Position of the last non-whitespace character before `to` (bodies include trailing newlines). */
function trimEnd(source: string, to: number): number {
  let pos = to;
  while (pos > 0 && /\s/.test(source[pos - 1]!)) pos--;
  return Math.max(0, pos - 1);
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number containing character offset `pos`. */
function lineOf(lineStarts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Depth-first flattening, convenient for counts and lists. */
export function flattenOutline(symbols: readonly OutlineSymbol[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const walk = (list: readonly OutlineSymbol[]) => {
    for (const s of list) {
      out.push(s);
      walk(s.children);
    }
  };
  walk(symbols);
  return out;
}
