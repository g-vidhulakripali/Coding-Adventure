import { describe, expect, it } from 'vitest';
import { sampleProject } from '../../demo/sample-repository';
import { csvToDataFrame, parseCsvRows } from './csv';
import { simulate, type SimulationProgram } from './interpreter';
import { pyRepr, pyStrOf, type PyValue } from './values';

async function sampleProgram(): Promise<SimulationProgram> {
  const sources = new Map<string, string>();
  const dataFiles = new Map<string, string>();
  for (const f of sampleProject.files) {
    if (f.category === 'python') sources.set(f.path, await sampleProject.readText(f.path));
    if (f.category === 'csv') dataFiles.set(f.path, await sampleProject.readText(f.path));
  }
  return { sources, dataFiles };
}

const show = (v: PyValue | null) => (v ? pyRepr(v) : null);

describe('CSV reading', () => {
  it('parses quoted cells and infers pandas column types', () => {
    expect(parseCsvRows('a,b\n1,"x, y"\n2,"say ""hi"""\n')).toEqual([['a', 'b'], ['1', 'x, y'], ['2', 'say "hi"']]);
    const df = csvToDataFrame('station,hours,stationary,ok\nnorth,10.5,2,True\nsouth,,0,False\n', 'd.csv');
    expect(df.columns.map((c) => [c.name, c.dtype])).toEqual([
      ['station', 'object'],
      ['hours', 'float64'],
      ['stationary', 'int64'],
      ['ok', 'bool'],
    ]);
    expect(Number.isNaN((df.columns[1]!.items[1] as { v: number }).v)).toBe(true);
  });
});

describe('classes, objects and methods', () => {
  it('makes an object, runs __init__, then load() reads the project CSV into self.frame', async () => {
    const program = await sampleProgram();
    const t = simulate(program, { kind: 'method', path: 'analysis/usage.py', className: 'UsageReport', method: 'load', initArgs: new Map(), args: new Map() });
    expect(t.status).toBe('completed');
    const kinds = t.steps.map((s) => `${s.kind}:${s.title}`);
    expect(kinds).toContain('call:Create object');
    expect(kinds).toContain('enter:Enter method');
    expect(kinds).toContain('builtin:Read CSV file');

    const read = t.steps.find((s) => s.title === 'Read CSV file')!;
    expect(read.output?.t).toBe('dataframe');
    expect(read.explanation.what).toContain('data/usage.csv');
    expect(read.explanation.what).toContain('3 rows');

    // __init__ stored the default path, load() stored the table on the object.
    const setPath = t.steps.find((s) => s.code === 'self.csv_path = csv_path')!;
    expect(setPath.target).toMatchObject({ kind: 'variable', names: ['self.csv_path'] });
    const ret = t.steps.filter((s) => s.kind === 'return').pop()!;
    expect(ret.code).toBe('return self.frame');
    expect(ret.output?.t).toBe('dataframe');
    expect(t.assumptions.some((a) => a.includes('repository root'))).toBe(true);
  });

  it('shows the object with its fields in the call stack', async () => {
    const program = await sampleProgram();
    const t = simulate(program, { kind: 'method', path: 'analysis/usage.py', className: 'UsageReport', method: 'load', initArgs: new Map(), args: new Map() });
    const last = t.steps[t.steps.length - 1]!;
    const self = last.frames[last.frames.length - 1]!.vars.find((v) => v.name === 'self')!.value;
    expect(self.t).toBe('instance');
    if (self.t !== 'instance') return;
    expect(self.fields.map(([k]) => k)).toEqual(['csv_path', 'frame']);
    expect(show(self.fields[0]![1])).toBe("'data/usage.csv'");
    expect(self.fields[1]![1].t).toBe('dataframe');
  });

  it('runs a property through its getter, and the user can change __init__ values', async () => {
    const program = await sampleProgram();
    const t = simulate(program, { kind: 'method', path: 'analysis/usage.py', className: 'UsageReport', method: 'total_hours', initArgs: new Map(), args: new Map() });
    expect(t.status).toBe('completed');
    // frame is still None, so the property takes the `if` branch and returns 0.0 — exactly what Python does.
    expect(show(t.steps.filter((s) => s.kind === 'return').pop()!.output)).toBe('0.0');

    const missing = simulate(program, {
      kind: 'method',
      path: 'analysis/usage.py',
      className: 'UsageReport',
      method: 'load',
      initArgs: new Map<string, PyValue>([['csv_path', { t: 'str', v: 'data/other.csv' }]]),
      args: new Map(),
    });
    expect(missing.stop).toMatchObject({ kind: 'missing-data', path: 'data/other.csv' });

    const supplied = simulate(
      { ...program, dataFiles: new Map([['data/other.csv', 'station,hours\na,1.5\nb,2.5\n']]) },
      { kind: 'method', path: 'analysis/usage.py', className: 'UsageReport', method: 'load', initArgs: new Map<string, PyValue>([['csv_path', { t: 'str', v: 'data/other.csv' }]]), args: new Map() },
    );
    expect(supplied.status).toBe('completed');
  });

  it('simulates scripts that create objects, call methods and sum a column', () => {
    const src = `import pandas as pd

class Shop:
    tax = 0.2

    def __init__(self, prices):
        self.prices = prices
        self.visits = 0

    def total(self):
        self.visits += 1
        return sum(self.prices) * (1 + self.tax)

    @property
    def count(self):
        return len(self.prices)

s = Shop([10, 20])
print(s.total(), s.count, s.visits)
df = pd.read_csv("data.csv")
print(float(df["hours"].sum()), len(df), df.shape)
`;
    const t = simulate({ sources: new Map([['shop.py', src]]), dataFiles: new Map([['data.csv', 'name,hours\na,1.5\nb,2.0\n']]) }, { kind: 'script', path: 'shop.py' });
    expect(t.stop).toBeNull();
    expect(t.console).toEqual(['36.0 2 1', '3.5 2 (2, 2)']);
  });

  it('prints a table like pandas (approximately)', () => {
    const df = csvToDataFrame('station,hours\nnorth,10.5\nsouth,20.0\n', 'x.csv');
    expect(pyStrOf(df)).toBe('  station  hours\n0   north   10.5\n1   south   20.0');
  });

  it('reports unknown attributes with Python wording', () => {
    const t = simulate({ sources: new Map([['a.py', 'class A:\n    pass\n\na = A()\nprint(a.missing)\n']]) }, { kind: 'script', path: 'a.py' });
    expect(t.stop?.message).toBe("AttributeError: 'A' object has no attribute 'missing'");
  });
});

describe('method scenarios, stories and lines for objects', () => {
  it('offers the public methods of a class, with __init__ defaults pre-filled', async () => {
    const { parsePythonModule } = await import('../parser/python/ast');
    const { findScenarios } = await import('./scenarios');
    const src = await sampleProject.readText('analysis/usage.py');
    const methods = findScenarios('analysis/usage.py', parsePythonModule(src)).filter((s) => s.kind === 'method');
    expect(methods.map((m) => m.label)).toEqual(['Use UsageReport: load()', 'Use UsageReport: read .total_hours']);
    const load = methods[0]!;
    if (load.kind !== 'method') return;
    expect(load.initParams).toEqual([{ name: 'csv_path', defaultValue: { t: 'str', v: 'data/usage.csv' } }]);
  });

  it('tells the story of making an object, reading the CSV and taking a column', async () => {
    const { storyFor } = await import('../visualisation/story');
    const program = await sampleProgram();
    const src = 'import pandas as pd\n\nclass R:\n    def __init__(self, path):\n        self.frame = pd.read_csv(path)\n\n    def total(self):\n        return float(self.frame["hours"].sum())\n\nr = R("data/usage.csv")\nprint(r.total())\n';
    const t = simulate({ sources: new Map([['r.py', src]]), dataFiles: program.dataFiles! }, { kind: 'script', path: 'r.py' });
    expect(t.console).toEqual(['61.0']);
    const label = (title: string) => storyFor(t.steps.find((s) => s.title === title)!, t).label;
    expect(label('Create object')).toBe('new R');
    expect(label('Read CSV file')).toBe('read data/usage.csv');
    expect(label('Select element by index')).toBe('column hours');
  });

  it('shows a method as a container owned by its class', async () => {
    const { buildLineView } = await import('../visualisation/lines');
    const program = await sampleProgram();
    const t = simulate(program, { kind: 'method', path: 'analysis/usage.py', className: 'UsageReport', method: 'load', initArgs: new Map(), args: new Map() });
    const idx = t.steps.findIndex((s) => s.title === 'Read CSV file');
    const view = buildLineView(t, idx, program.sources)!;
    expect(view.frame).toMatchObject({ kind: 'function', name: 'load', owner: 'UsageReport' });
    expect(view.nodes.map((n) => [n.line, n.status])).toEqual([
      [22, 'current'],
      [23, 'pending'],
    ]);
  });
});
