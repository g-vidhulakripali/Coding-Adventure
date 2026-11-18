import { describe, expect, it } from 'vitest';
import { parseLineRange } from '../core/source-mapping/types';
import { buildHash, parseHash, type Route } from './router';

describe('parseHash', () => {
  it('parses home', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
  });

  it('parses a workspace deep link', () => {
    expect(parseHash('#/project/sample?file=analysis%2Fusage.py&line=8-10')).toEqual({
      name: 'workspace',
      projectId: 'sample',
      file: 'analysis/usage.py',
      lines: { startLine: 8, endLine: 10 },
    });
  });

  it('ignores invalid line values', () => {
    const route = parseHash('#/project/sample?file=main.py&line=abc');
    expect(route.name === 'workspace' && route.lines).toBeNull();
  });

  it('reports unknown paths', () => {
    expect(parseHash('#/nope')).toEqual({ name: 'not-found', path: '/nope' });
  });
});

describe('buildHash round-trip', () => {
  const routes: Route[] = [
    { name: 'home' },
    { name: 'workspace', projectId: 'sample', file: null, lines: null },
    { name: 'workspace', projectId: 'my project', file: 'dir with space/a&b.py', lines: { startLine: 3, endLine: 3 } },
    { name: 'workspace', projectId: 'p', file: 'x.py', lines: { startLine: 2, endLine: 9 } },
  ];
  it.each(routes)('%o', (route) => {
    expect(parseHash(buildHash(route))).toEqual(route);
  });
});

describe('parseLineRange', () => {
  it.each([
    ['5', { startLine: 5, endLine: 5 }],
    ['5-7', { startLine: 5, endLine: 7 }],
    ['0', null],
    ['7-5', null],
    ['-3', null],
    ['', null],
  ])('%s', (input, expected) => {
    expect(parseLineRange(input)).toEqual(expected);
  });
});
