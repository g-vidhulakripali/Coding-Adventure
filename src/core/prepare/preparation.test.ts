import { describe, expect, it } from 'vitest';
import { analysePythonFile, type FileAnalysis } from '../analysis/python/fileAnalysis';
import type { RepositoryFile } from '../repository/types';
import { Preparation, type PreparationOptions } from './preparation';

const file = (path: string, category: RepositoryFile['category'] = 'python'): RepositoryFile => ({ path, name: path, size: 1, category });
const tick = () => new Promise((r) => setTimeout(r));
async function until(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await tick();
}

function setup(over: Partial<PreparationOptions> = {}) {
  const sources = new Map([['a.py', 'x = 1\n'], ['b.py', 'y = 22\n'], ['c.py', 'z = 333\n']]);
  const analysed: string[] = [];
  const saved = new Map<string, FileAnalysis>();
  let clock = 0;
  const options: PreparationOptions = {
    files: [...[...sources.keys()].map((p) => file(p)), file('logo.png', 'image'), file('x.bin', 'other')],
    sources,
    excluded: new Map(),
    concurrency: 1,
    analyse: async (path, source) => {
      analysed.push(path);
      await tick();
      return analysePythonFile(path, source);
    },
    loadStored: async () => saved,
    save: async (a) => void saved.set(a.path, a),
    onChange: () => undefined,
    now: () => (clock += 100),
    ...over,
  };
  return { prep: new Preparation(options), analysed, saved, options };
}

describe('Preparation', () => {
  it('prepares every file, stores each one at once, and lists all files with a state', async () => {
    const { prep, saved } = setup();
    await prep.start();
    await until(() => prep.snapshot().state === 'done');
    expect(saved.size).toBe(3);
    expect(prep.snapshot()).toMatchObject({ total: 5, prepared: 4, unsupported: 1, failed: 0, remaining: 0 });
  });

  it('uses stored results and analyses only what is missing or changed', async () => {
    const first = setup();
    await first.prep.start();
    await until(() => first.prep.snapshot().state === 'done');
    const sources = new Map([...first.options.sources, ['b.py', 'y = 22222\n']]);
    const second = setup({ sources, loadStored: async () => new Map([...first.saved].filter(([p]) => p !== 'c.py')) });
    await second.prep.start();
    await until(() => second.prep.snapshot().state === 'done');
    expect(second.analysed.sort()).toEqual(['b.py', 'c.py']);
    expect(second.prep.snapshot().stored).toBe(1);
  });

  it('ignores results of another analysis version', async () => {
    const old = { ...analysePythonFile('a.py', 'x = 1\n'), version: 0 };
    const { prep, analysed } = setup({ loadStored: async () => new Map([['a.py', old]]) });
    await prep.start();
    await until(() => prep.snapshot().state === 'done');
    expect(analysed).toContain('a.py');
  });

  it('resumes after an interruption without repeating finished files', async () => {
    const saved = new Map<string, FileAnalysis>();
    const one = setup({ loadStored: async () => saved, save: async (a) => void saved.set(a.path, a) });
    await one.prep.start();
    await until(() => saved.size >= 1);
    one.prep.cancel();
    const done = [...saved.keys()];
    const two = setup({ loadStored: async () => saved, save: async (a) => void saved.set(a.path, a) });
    await two.prep.start();
    await until(() => two.prep.snapshot().state === 'done');
    for (const p of done) expect(two.analysed).not.toContain(p);
    expect(saved.size).toBe(3);
  });

  it('pauses and goes on', async () => {
    const { prep, analysed } = setup();
    await prep.start();
    prep.pause();
    await tick();
    await tick();
    const n = analysed.length;
    await tick();
    expect(analysed.length).toBe(n);
    expect(prep.snapshot().state).toBe('paused');
    prep.resume();
    await until(() => prep.snapshot().state === 'done');
    expect(analysed).toHaveLength(3);
  });

  it('reports a failing file and goes on; excluded files keep their reason', async () => {
    const { prep } = setup({
      excluded: new Map([['logo.png', 'too large']]),
      analyse: async (path, source) => {
        if (path === 'b.py') throw new Error('crashed');
        return analysePythonFile(path, source);
      },
    });
    await prep.start();
    await until(() => prep.snapshot().state === 'done');
    expect(prep.statuses.get('b.py')).toEqual({ state: 'failed', reason: 'crashed' });
    expect(prep.statuses.get('logo.png')).toEqual({ state: 'failed', reason: 'too large' });
    expect(prep.statuses.get('c.py')!.state).toBe('prepared');
  });

  it('goes on when nothing can be stored (full storage)', async () => {
    const { prep } = setup({ save: () => Promise.reject(new Error('full')), loadStored: () => Promise.reject(new Error('broken')) });
    await prep.start();
    await until(() => prep.snapshot().state === 'done');
    expect(prep.results.size).toBe(3);
  });

  it('takes the open file first and gives no time estimate without measurements', async () => {
    const { prep, analysed } = setup();
    await prep.start('c.py');
    expect(prep.snapshot().etaMs).toBeNull();
    await until(() => prep.snapshot().state === 'done');
    expect(analysed[0]).toBe('c.py');
  });
});
