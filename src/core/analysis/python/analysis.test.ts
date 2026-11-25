// The app has no Node types on purpose; this only reads the grammar file for the test.
// @ts-ignore
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePythonModule } from '../../parser/python/ast';
import { compareStructures, loadTreeSitter, treeSitterStructure } from '../../parser/python/treeSitter';
import { chaptersOf } from '../../visualisation/chapters';
import { coverageOf } from './coverage';
import { ANALYSIS_VERSION, analysePythonFile } from './fileAnalysis';
import { ProjectIndex } from './projectIndex';

const MESSY = `import os
from dataclasses import dataclass

@dataclass(frozen=True)
class P:
    x: int = 1

    @property
    def double(self):
        return self.x * 2

async def fetch(url):
    return await get(url)

def outer(items):
    def inner(i):
        return [j for j in range(i) if j]
    try:
        with open("a") as f:
            return {k: inner(k) for k in items}
    except (OSError, ValueError) as e:
        raise RuntimeError(f"bad {e!r}") from e
    finally:
        print("done")
`;

describe('coverage', () => {
  it('counts every statement and names what is read but not simulated', () => {
    const c = coverageOf(parsePythonModule(MESSY));
    expect(c.understood).toBe(c.statements);
    expect(c.counts).toMatchObject({ classes: 1, functions: 3, 'async functions': 1, decorators: 2, comprehensions: 2, exceptions: 1, imports: 2, 'with blocks': 1, awaits: 1 });
    expect(c.gaps.map((g) => g.kind)).toEqual(['not-run', 'not-run']);
    expect(c.gaps[0]!.line).toBe(12);
  });

  it('reports what cannot be read instead of skipping it', () => {
    const c = coverageOf(parsePythonModule('x = 1\ny = b"abc"\nmatch x:\n    case 1:\n        pass\n'));
    expect(c.statements).toBeGreaterThan(c.understood);
    expect(c.gaps.some((g) => g.kind === 'unread' && g.line === 2)).toBe(true);
    expect(c.gaps.some((g) => g.line === 3)).toBe(true);
  });
});

describe('Tree-sitter as second parser', () => {
  const bytes = (p: string) => new Uint8Array(readFileSync(p));
  const parser = () => loadTreeSitter({ runtime: bytes('node_modules/web-tree-sitter/tree-sitter.wasm'), python: bytes('node_modules/tree-sitter-python/tree-sitter-python.wasm') });

  it('agrees with the main parser on ordinary code', async () => {
    const p = await parser();
    const check = compareStructures(analysePythonFile('a.py', MESSY).structure, treeSitterStructure(p, MESSY));
    expect(check).toEqual({ agree: true, differences: [] });
  });

  it('reports every difference', async () => {
    const ts = treeSitterStructure(await parser(), 'def f():\n    g()\n');
    expect(ts).toEqual({ definitions: ['def f@1'], calls: 1, imports: 0, errors: 0 });
    const check = compareStructures({ definitions: ['def h@1'], calls: 2, imports: 1, errors: 1 }, ts);
    expect(check.agree).toBe(false);
    expect(check.differences).toHaveLength(5);
  });

  it('survives deeply nested code', async () => {
    const deep = `x = ${'('.repeat(3000)}1${')'.repeat(3000)}\n`;
    expect(treeSitterStructure(await parser(), deep).errors).toBe(0);
  });
});

describe('ProjectIndex', () => {
  const files = {
    'src/constants.py': 'LIMIT = 5\nNAMES = ["a"]\n',
    'src/tools.py': 'class Box:\n    def open(self):\n        return 1\n\ndef helper(x):\n    return x\n',
    'src/main.py': 'from src import constants as K\nfrom src.tools import helper, Box\nimport src.tools\n\ndef run(box):\n    box.open()\n    helper(K.LIMIT)\n    return Box.open, src.tools.helper\n',
  };
  const index = new ProjectIndex(new Map(Object.entries(files).map(([p, s]) => [p, analysePythonFile(p, s)])));

  it('follows imports, aliases, constants and classes to their definition', () => {
    const at = (name: string) => index.resolve('src/main.py', name)?.target;
    expect(at('K.LIMIT')).toMatchObject({ path: 'src/constants.py', line: 1, kind: 'constant' });
    expect(at('K')).toMatchObject({ path: 'src/constants.py', kind: 'file' });
    expect(at('helper')).toMatchObject({ path: 'src/tools.py', line: 5 });
    expect(at('Box.open')).toMatchObject({ path: 'src/tools.py', line: 2, kind: 'method' });
    expect(at('src.tools.helper')).toMatchObject({ line: 5 });
    expect(at('box')).toBeUndefined();
  });

  it('knows where a definition is used, across files', () => {
    expect(index.usesOf({ path: 'src/tools.py', name: 'helper' }).map((u) => u.use.span.startLine)).toEqual([7, 8]);
    expect(index.usesOf({ path: 'src/constants.py', name: 'LIMIT' })).toHaveLength(1);
    expect(index.usesOf({ path: 'src/constants.py', name: 'NAMES' })).toHaveLength(0);
  });

  it('answers what is under the cursor, and does not guess the type of a parameter', () => {
    expect(index.at('src/main.py', 7, 13)?.target.name).toBe('LIMIT');
    expect(index.at('src/main.py', 6, 9)).toBeNull();
    expect(index.definitionAt('src/tools.py', 5)?.name).toBe('helper');
    expect(index.definitionAt('src/constants.py', 1)?.kind).toBe('constant');
  });
});

describe('analysePythonFile', () => {
  it('is plain data that survives storing', () => {
    const a = analysePythonFile('a.py', MESSY);
    expect(a.version).toBe(ANALYSIS_VERSION);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('notes texts that look like paths, and whether they are complete', () => {
    const a = analysePythonFile('a.py', 'import os\nx = open("data/a.csv")\ny = os.path.join(base, "b.json")\nz = base + "/c.png"\nw = f"{base}/d.svg"\nu = "https://x.org/e.png"\nv = "1.5"\n');
    expect(a.paths.map((p) => [p.value, p.whole])).toEqual([['data/a.csv', true], ['b.json', false], ['/c.png', false], ['/d.svg', false]]);
  });
});

describe('chaptersOf', () => {
  it('follows comments and blank lines, and every statement is in exactly one chapter', () => {
    const lines: string[] = [];
    const statements: Array<{ line: number; endLine: number }> = [];
    for (let g = 0; g < 4; g++) {
      lines.push(`# Part ${g + 1}`);
      for (let i = 0; i < 4; i++) {
        statements.push({ line: lines.length + 1, endLine: lines.length + 3 });
        lines.push('x = (', '  1', ')');
      }
      lines.push('');
    }
    const chapters = chaptersOf(statements, lines);
    expect(chapters.map((c) => c.title)).toEqual(['Part 1', 'Part 2', 'Part 3', 'Part 4']);
    expect(chapters.flatMap((c) => Array.from({ length: c.last - c.first + 1 }, (_, i) => c.first + i))).toEqual(statements.map((_, i) => i));
  });

  it('leaves short code whole, and cuts very long stretches', () => {
    expect(chaptersOf([{ line: 1, endLine: 1 }], ['x = 1'])).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => ({ line: i + 1, endLine: i + 1 }));
    const chapters = chaptersOf(many, many.map(() => 'x = 1'));
    expect(chapters.length).toBeGreaterThan(3);
    expect(chapters[chapters.length - 1]!.last).toBe(59);
  });
});
