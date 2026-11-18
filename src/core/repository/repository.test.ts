import { describe, expect, it } from 'vitest';
import { detectCategory, extensionOf, viewerLanguageFor } from './fileTypes';
import { ancestorFolders, buildRepositoryTree, filterTree } from './tree';
import type { RepositoryFile, RepositoryTreeNode } from './types';

const file = (path: string): RepositoryFile => ({
  path,
  name: path.split('/').pop()!,
  size: 1,
  category: detectCategory(path),
});

const allPaths = (node: RepositoryTreeNode): string[] =>
  node.kind === 'file' ? [node.path] : node.children.flatMap(allPaths);

describe('detectCategory', () => {
  it.each([
    ['main.py', 'python'],
    ['pkg/types.pyi', 'python'],
    ['notebooks/a.ipynb', 'notebook'],
    ['assets/logo.svg', 'svg'],
    ['assets/photo.JPG', 'image'],
    ['config.yml', 'yaml'],
    ['data/x.csv', 'csv'],
    ['README.md', 'markdown'],
    ['requirements.txt', 'dependency-manifest'],
    ['requirements-test.txt', 'dependency-manifest'],
    ['pyproject.toml', 'dependency-manifest'],
    ['setup.py', 'dependency-manifest'],
    ['other.toml', 'toml'],
    ['LICENSE', 'text'],
    ['.gitignore', 'text'],
    ['model.bin', 'other'],
    ['archive.tar.gz', 'other'],
  ])('%s → %s', (path, category) => {
    expect(detectCategory(path)).toBe(category);
  });

  it('does not treat a leading dot as an extension', () => {
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('a.b.PY')).toBe('py');
  });

  it('highlights setup.py as Python even though it is a manifest', () => {
    expect(viewerLanguageFor('setup.py', 'dependency-manifest')).toBe('python');
    expect(viewerLanguageFor('requirements.txt', 'dependency-manifest')).toBeNull();
    expect(viewerLanguageFor('nb.ipynb', 'notebook')).toBe('json');
  });
});

describe('buildRepositoryTree', () => {
  const files = [
    'main.py',
    'b/file10.py',
    'b/file2.py',
    'a/deep/nested/x.txt',
    'Zeta.md',
    'a/readme.md',
    'b/.hidden',
  ].map(file);

  it('keeps every file exactly once with its original path', () => {
    const tree = buildRepositoryTree(files);
    const paths = allPaths(tree);
    expect(paths).toHaveLength(files.length);
    expect(new Set(paths)).toEqual(new Set(files.map((f) => f.path)));
    expect(tree.fileCount).toBe(files.length);
  });

  it('lists folders before files and sorts naturally', () => {
    const tree = buildRepositoryTree(files);
    expect(tree.children.map((c) => c.name)).toEqual(['a', 'b', 'main.py', 'Zeta.md']);
    const b = tree.children[1]!;
    expect(b.kind === 'folder' && b.children.map((c) => c.name)).toEqual(['.hidden', 'file2.py', 'file10.py']);
  });

  it('computes recursive file counts and folder paths', () => {
    const tree = buildRepositoryTree(files);
    const a = tree.children[0]!;
    expect(a.kind).toBe('folder');
    if (a.kind !== 'folder') return;
    expect(a.fileCount).toBe(2);
    const deep = a.children[0]!;
    expect(deep.path).toBe('a/deep');
  });

  it('handles an empty repository', () => {
    const tree = buildRepositoryTree([]);
    expect(tree.children).toEqual([]);
    expect(tree.fileCount).toBe(0);
  });
});

describe('filterTree', () => {
  const tree = buildRepositoryTree(['src/app.py', 'src/util/strings.py', 'docs/guide.md'].map(file));

  it('keeps matching files and their folders', () => {
    const filtered = filterTree(tree, 'STRINGS')!;
    expect(allPaths(filtered)).toEqual(['src/util/strings.py']);
    expect(filtered.fileCount).toBe(1);
  });

  it('returns null when nothing matches and the full tree for an empty query', () => {
    expect(filterTree(tree, 'nope')).toBeNull();
    expect(filterTree(tree, '  ')).toBe(tree);
  });
});

describe('ancestorFolders', () => {
  it('returns outermost-first folder paths', () => {
    expect(ancestorFolders('a/b/c.py')).toEqual(['a', 'a/b']);
    expect(ancestorFolders('top.py')).toEqual([]);
  });
});
