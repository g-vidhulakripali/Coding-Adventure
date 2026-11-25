// @ts-ignore The app has no Node types on purpose; the test needs a Blob with streams.
import { Blob as NodeBlob, Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findAssets, htmlMentions, markdownMentions, mentionsIn, styleAndScriptMentions } from './assets/assets';
import { analysePythonFile } from './analysis/python/fileAnalysis';
import { findLibraries, unusedRequirements } from './dependencies/libraries';
import { parseRequirement, readManifest } from './dependencies/manifests';
import { readZip } from './import/zip';
import { ZipWriter } from './import/zipWriter';
import { isBackup, usableAnalysis } from './project/backup';
import { detectCategory } from './repository/fileTypes';
import { notebookToPython, parseNotebook } from './repository/notebook';
import { imageSize, mismatch, sniff } from './repository/sniff';
import { fromJson, fromToml, fromYaml, get, texts, type Structured } from './structured/structured';

describe('notebooks', () => {
  const nb = JSON.stringify({
    metadata: { kernelspec: { language: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'text'] },
      { cell_type: 'code', source: ['%matplotlib inline\n', 'x = 1\n', '!ls'], outputs: [{}, {}] },
      { cell_type: 'code', source: '%%bash\necho hi' },
      { cell_type: 'raw', source: 'anything' },
    ],
  });

  it('keeps every cell with its lines, and Jupyter commands as comments', () => {
    const t = notebookToPython(nb);
    const lines = t.source.split('\n');
    expect(t.cells.map((c) => [c.number, c.kind, lines[c.startLine - 1]])).toEqual([
      [1, 'markdown', '# %% cell 1 (markdown)'],
      [2, 'code', '# %% cell 2 (code)'],
      [3, 'code', '# %% cell 3 (code)'],
      [4, 'raw', '# %% cell 4 (raw)'],
    ]);
    expect(t.source).toContain('pass  # %matplotlib inline\nx = 1\npass  # !ls');
    expect(t.source).toContain('# echo hi');
    expect(t.magics).toBe(4);
    expect(analysePythonFile('a.ipynb', t.source).coverage.syntaxErrors).toBe(0);
  });

  it('counts outputs but does not use them, and refuses broken files', () => {
    expect(parseNotebook(nb).cells[1]!.outputs).toBe(2);
    expect(() => parseNotebook('{')).toThrow(/JSON/);
    expect(() => parseNotebook('{"a": 1}')).toThrow(/cells/);
  });
});

describe('content checks', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0]);
  it('judges files by their bytes', () => {
    expect(sniff(png)).toBe('png');
    expect(imageSize(png, 'png')).toEqual({ width: 512, height: 256 });
    expect(sniff(new TextEncoder().encode('<html><script>'))).toBe('text');
    expect(sniff(new Uint8Array([0x4d, 0x5a, 1]))).toBe('program');
    expect(sniff(new Uint8Array([80, 75, 3, 4]))).toBe('zip');
    expect(sniff(new Uint8Array([1, 0, 2]))).toBe('binary');
    expect(sniff(new Uint8Array())).toBe('empty');
  });
  it('says when a name lies', () => {
    expect(mismatch('image', 'text')).toContain('not shown as an image');
    expect(mismatch('python', 'program')).toContain('a program');
    expect(mismatch('image', 'png')).toBeNull();
  });
});

const plain = (s: Structured): unknown => (s.kind === 'scalar' ? s.text : s.kind === 'array' ? s.items.map(plain) : Object.fromEntries(s.entries.map(([k, v]) => [k, plain(v)])));

describe('structured files', () => {
  it('reads JSON and YAML as trees', async () => {
    expect(plain(fromJson('{"a": [1, true, null, "x"]}'))).toEqual({ a: ['1', 'true', 'null', 'x'] });
    expect(plain(await fromYaml('name: demo # c\nlist:\n  - 1\n  - b: "q"\nflow: {x: 1, y: [2, 3]}\nempty:\n'))).toEqual({ name: 'demo', list: ['1', { b: 'q' }], flow: { x: '1', y: ['2', '3'] }, empty: '' });
  });
  it('reads the TOML of Python projects and refuses what it does not know', () => {
    const t = fromToml('[project]\nname = "x"\ndependencies = [\n  "numpy>=1.2", # c\n  \'pandas\',\n]\n[tool.poetry.dependencies]\nrequests = { version = "^2.0", extras = ["a"] }\n[[tool.x]]\nk = 1\n[[tool.x]]\nk = 2\n');
    expect(texts(get(get(t, 'project'), 'dependencies'))).toEqual(['numpy>=1.2', 'pandas']);
    expect(plain(get(get(t, 'tool'), 'x')!)).toEqual([{ k: '1' }, { k: '2' }]);
    expect(() => fromToml('a = [1\nb = 2')).toThrow(/Line/);
  });
});

describe('libraries', () => {
  it('reads requirement lines', () => {
    expect(parseRequirement('Pandas[excel] >= 2.0, <3 ; python_version > "3.8"  # c')).toEqual({ name: 'pandas', spec: '>=2.0,<3' });
    expect(parseRequirement('-r other.txt')).toBeNull();
    expect(parseRequirement('# c')).toBeNull();
    expect(parseRequirement('scikit_learn')).toEqual({ name: 'scikit-learn', spec: '' });
  });

  it('reads every kind of project file', async () => {
    const names = async (path: string, text: string) => (await readManifest(path, text)).requirements.map((r) => `${r.name}${r.spec}`);
    expect(await names('requirements.txt', 'numpy==1.26.4\n\n# x\n')).toEqual(['numpy==1.26.4']);
    expect(await names('pyproject.toml', '[project]\ndependencies = ["a>1"]\n[tool.poetry.dependencies]\npython = "^3.9"\nb = "1.0"\nc = "*"\n')).toEqual(['a>1', 'b==1.0', 'c']);
    expect(await names('environment.yml', 'dependencies:\n  - python=3.11\n  - numpy=1.26\n  - pip:\n    - torch>=2\n')).toEqual(['numpy==1.26', 'torch>=2']);
    expect(await names('setup.py', 'from setuptools import setup\nsetup(install_requires=["x>=1", "y"])\n')).toEqual(['x>=1', 'y']);
    expect(await names('setup.cfg', '[options]\ninstall_requires =\n    z\n    w>2\npackages = find:\n')).toEqual(['z', 'w>2']);
    expect(await names('Pipfile', '[packages]\nflask = "*"\n')).toEqual(['flask']);
    expect((await readManifest('pyproject.toml', '[broken')).problem).toContain('Line');
  });

  const src = 'import numpy as np\nimport os.path\nfrom sklearn.linear_model import Ridge\nimport mystery\nfrom pkg.tool import helper\n\nprint(np.mean([1]), np.mean([2]), os.path.join("a"), Ridge(), helper())\n';
  const files = new Map([
    ['main.py', analysePythonFile('main.py', src)],
    ['pkg/tool.py', analysePythonFile('pkg/tool.py', 'def helper():\n    return 1\n')],
  ]);
  const reqs = [
    { name: 'numpy', spec: '==1.26.4', file: 'r.txt', line: 1 },
    { name: 'unused', spec: '', file: 'r.txt', line: 2 },
  ];
  const libs = findLibraries(files, reqs);

  it('tells packages, standard library, built-ins and own modules apart', () => {
    expect(libs.map((l) => `${l.kind}:${l.name}`)).toEqual(['third-party:mystery', 'third-party:numpy', 'third-party:sklearn', 'stdlib:os', 'builtin:Python', 'internal:pkg/tool.py']);
  });
  it('shows versions, names used, and links for the exact version only when it is known', () => {
    const numpy = libs.find((l) => l.name === 'numpy')!;
    expect(numpy).toMatchObject({ docs: 'https://numpy.org/doc/1.26/', docsForVersion: true, aliases: ['numpy as np'] });
    expect(numpy.uses).toMatchObject([{ name: 'numpy.mean', places: [{ line: 7 }, { line: 7 }] }]);
    expect(libs.find((l) => l.name === 'sklearn')).toMatchObject({ distribution: 'scikit-learn', docsForVersion: false });
  });
  it('invents no purpose for unknown packages and lists requirements nobody imports', () => {
    expect(libs.find((l) => l.name === 'mystery')).toMatchObject({ purpose: null, docs: null, requirements: [] });
    expect(unusedRequirements(libs, reqs).map((r) => r.name)).toEqual(['unused']);
  });
});

describe('assets', () => {
  const files = ['app/main.py', 'app/data/a.csv', 'app/img/logo.png', 'docs/logo.png', 'app/conf.yml', 'README.md'].map((path) => ({ path, name: path.split('/').pop()!, size: 1, category: detectCategory(path) }));
  it('is certain only for complete paths that lead to one file', () => {
    const code = analysePythonFile('app/main.py', 'import os\na = open("data/a.csv")\nb = os.path.join(x, "conf.yml")\nc = os.path.join(x, "logo.png")\nd = open("missing.json")\n');
    const r = findAssets(files, mentionsIn([code]));
    const of = (p: string) => r.assets.find((a) => a.file.path === p)!.references.map((x) => x.certainty);
    expect(of('app/data/a.csv')).toEqual(['certain']);
    expect(of('app/conf.yml')).toEqual(['likely']);
    expect(of('docs/logo.png')).toEqual(['unclear']);
    expect(of('README.md')).toEqual([]);
    expect(r.unresolved.map((u) => u.mention.text)).toEqual(['missing.json']);
  });
  it('reads Markdown, HTML, CSS and JavaScript without running anything', () => {
    expect(markdownMentions('README.md', '![x](app/img/logo.png "t") [s](https://x.org/a.png)\n```\n![no](no.png)\n```\n').map((m) => m.text)).toEqual(['app/img/logo.png']);
    (globalThis as { pwned?: boolean }).pwned = false;
    expect(htmlMentions('i.html', '<script>globalThis.pwned=true</script><img src="a.png" onerror="globalThis.pwned=true"><link href="s.css">').map((m) => m.text)).toEqual(['a.png', 's.css']);
    expect((globalThis as { pwned?: boolean }).pwned).toBe(false);
    expect(styleAndScriptMentions('a.css', 'body { background: url("b.png") }').map((m) => m.text)).toEqual(['b.png']);
    expect(styleAndScriptMentions('a.js', "import x from './y.js'\nimport z from 'react'").map((m) => m.text)).toEqual(['./y.js']);
  });
});

describe('backups', () => {
  const original = globalThis.Blob;
  beforeAll(() => {
    globalThis.Blob = NodeBlob as unknown as typeof Blob;
  });
  afterAll(() => {
    globalThis.Blob = original;
  });

  it('writes ZIPs that the reader accepts, byte for byte', async () => {
    const zip = new ZipWriter();
    await zip.add('a/ö.txt', 'hello '.repeat(1000));
    await zip.add('b.bin', new Blob([new Uint8Array([1, 2, 3])]));
    await zip.add('code-playground.json', '{}');
    const file = zip.finish();
    const entries = await readZip(file);
    expect(entries.map((e) => [e.rawPath, e.size, e.problem])).toEqual([['a/ö.txt', 6000, null], ['b.bin', 3, null], ['code-playground.json', 2, null]]);
    expect(Buffer.from(await (await entries[0]!.extract()).arrayBuffer()).toString()).toBe('hello '.repeat(1000));
    expect([...new Uint8Array(await (await entries[1]!.extract()).arrayBuffer())]).toEqual([1, 2, 3]);
    expect(isBackup(entries)).toBe(true);
  });

  it('uses stored results only when they are complete and belong to the backup', () => {
    const good = JSON.parse(JSON.stringify(analysePythonFile('a.py', 'x = f(1)\n')));
    expect(usableAnalysis(good, new Set(['a.py']))).toBe(true);
    expect(usableAnalysis(good, new Set(['b.py']))).toBe(false);
    expect(usableAnalysis({ ...good, version: 0 }, new Set(['a.py']))).toBe(false);
    expect(usableAnalysis({ ...good, calls: { ...good.calls, calls: [{}] } }, new Set(['a.py']))).toBe(false);
    expect(usableAnalysis(null, new Set(['a.py']))).toBe(false);
  });
});
