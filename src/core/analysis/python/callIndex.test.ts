import { describe, expect, it } from 'vitest';
import { sampleProject } from '../../../demo/sample-repository';
import { buildCallIndex } from './callIndex';

async function sampleSources() {
  const map = new Map<string, string>();
  for (const f of sampleProject.files.filter((f) => f.category === 'python')) map.set(f.path, await sampleProject.readText(f.path));
  return map;
}

describe('buildCallIndex on the sample repository', () => {
  it('lists definitions including module scopes, functions, classes and methods', async () => {
    const index = buildCallIndex(await sampleSources());
    const ids = index.definitions.map((d) => `${d.kind}:${d.id}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        'module:main.py::<module>',
        'function:pricing.py::calculate_total',
        'function:analysis/usage.py::usage_for_first_station',
        'class:analysis/usage.py::UsageReport',
        'method:analysis/usage.py::UsageReport.load',
        'method:analysis/usage.py::UsageReport.refresh',
      ]),
    );
    expect(index.filesWithSyntaxErrors).toEqual([]);
  });

  it('resolves a cross-file call through an explicit import', async () => {
    const index = buildCallIndex(await sampleSources());
    const call = index.calls.find((c) => c.callee === 'calculate_total')!;
    expect(call.callerId).toBe('main.py::<module>');
    expect(call.span).toMatchObject({ path: 'main.py', startLine: 8 });
    expect(call.target).toMatchObject({ kind: 'internal', id: 'pricing.py::calculate_total', evidence: 'static' });
  });

  it('classifies built-ins, library calls, self-calls and unknown receivers', async () => {
    const index = buildCallIndex(await sampleSources());
    const byCallee = (callee: string) => index.calls.filter((c) => c.callee === callee);
    expect(byCallee('sum')[0]!.target).toEqual({ kind: 'builtin', name: 'sum' });
    expect(byCallee('pd.read_csv')[0]!.target).toEqual({ kind: 'library', module: 'pandas', name: 'read_csv' });
    expect(byCallee('pd.Series')[0]!.target).toEqual({ kind: 'library', module: 'pandas', name: 'Series' });
    const selfLoad = byCallee('self.load')[0]!;
    expect(selfLoad.callerId).toBe('analysis/usage.py::UsageReport.refresh');
    expect(selfLoad.target).toMatchObject({ kind: 'internal', id: 'analysis/usage.py::UsageReport.load', evidence: 'inferred' });
    expect(byCallee('hours_usage.to_numpy')[0]!.target.kind).toBe('unresolved');
    // Calls in the __main__ block belong to the module scope.
    expect(byCallee('usage_for_first_station')[0]).toMatchObject({ callerId: 'analysis/usage.py::<module>', target: { kind: 'internal', evidence: 'static' } });
  });

  it('resolves module-attribute calls and relative imports', () => {
    const index = buildCallIndex(
      new Map([
        ['app/main.py', 'from . import helpers\nimport app.util as u\nhelpers.go()\nu.run()\n'],
        ['app/__init__.py', ''],
        ['app/helpers.py', 'def go():\n    pass\n'],
        ['app/util.py', 'def run():\n    pass\n'],
      ]),
    );
    const targets = index.calls.map((c) => [c.callee, c.target.kind === 'internal' ? c.target.id : c.target.kind]);
    expect(targets).toEqual([
      ['helpers.go', 'app/helpers.py::go'],
      ['u.run', 'app/util.py::run'],
    ]);
  });
});
