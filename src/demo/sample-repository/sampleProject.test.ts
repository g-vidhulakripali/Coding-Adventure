import { describe, expect, it } from 'vitest';
import { sampleProject } from './index';
import { defaultFileFor } from '../../core/project/registry';

describe('sample project', () => {
  it('exposes every bundled file with its original path', () => {
    const paths = sampleProject.files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        'LICENSE',
        'README.md',
        'analysis/__init__.py',
        'analysis/usage.py',
        'assets/logo.svg',
        'assets/model.bin',
        'config/settings.yaml',
        'data/catalog.json',
        'data/usage.csv',
        'main.py',
        'notebooks/exploration.ipynb',
        'pricing.py',
        'requirements.txt',
      ].sort(),
    );
  });

  it('returns the original text unchanged', async () => {
    const text = await sampleProject.readText('pricing.py');
    expect(text).toBe(
      'def calculate_total(subtotal, discount):\n    discount_amount = subtotal * discount\n    final_amount = subtotal - discount_amount\n\n    return final_amount\n',
    );
  });

  it('refuses unknown and non-text files', async () => {
    await expect(sampleProject.readText('missing.py')).rejects.toThrow(/not found/);
    await expect(sampleProject.readText('assets/model.bin')).rejects.toThrow(/not viewable/);
  });

  it('opens main.py by default', () => {
    expect(defaultFileFor(sampleProject)).toBe('main.py');
  });

  it('records the byte size of each file', () => {
    const empty = sampleProject.files.find((f) => f.path === 'analysis/__init__.py');
    expect(empty?.size).toBe(0);
  });
});
