import type { FileNode, FolderNode, RepositoryFile, RepositoryTreeNode } from './types';

/**
 * Builds the explorer tree from the flat file list.
 *
 * Every file in the list appears exactly once in the tree — nothing is
 * filtered, renamed or flattened. Folders are listed before files, each group
 * sorted with a natural, case-insensitive order (so `file2` precedes `file10`).
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

interface MutableFolder {
  path: string;
  name: string;
  folders: Map<string, MutableFolder>;
  files: FileNode[];
}

export function buildRepositoryTree(files: readonly RepositoryFile[], rootName = ''): FolderNode {
  const root: MutableFolder = { path: '', name: rootName, folders: new Map(), files: [] };

  for (const file of files) {
    const segments = file.path.split('/');
    let folder = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      let child = folder.folders.get(segment);
      if (!child) {
        child = {
          path: folder.path ? `${folder.path}/${segment}` : segment,
          name: segment,
          folders: new Map(),
          files: [],
        };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push({ kind: 'file', path: file.path, name: file.name, file });
  }

  return freeze(root);
}

function freeze(folder: MutableFolder): FolderNode {
  const folders = [...folder.folders.values()]
    .map(freeze)
    .sort((a, b) => collator.compare(a.name, b.name));
  const files = [...folder.files].sort((a, b) => collator.compare(a.name, b.name));
  const fileCount = files.length + folders.reduce((sum, f) => sum + f.fileCount, 0);
  const children: RepositoryTreeNode[] = [...folders, ...files];
  return { kind: 'folder', path: folder.path, name: folder.name, children, fileCount };
}

/** Folder paths that must be expanded for `filePath` to be visible, outermost first. */
export function ancestorFolders(filePath: string): string[] {
  const segments = filePath.split('/');
  const result: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    result.push(segments.slice(0, i).join('/'));
  }
  return result;
}

/**
 * Filters the tree to files whose path contains `query` (case-insensitive),
 * keeping the folders that lead to them. Returns null when nothing matches.
 */
export function filterTree(node: FolderNode, query: string): FolderNode | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return node;
  const children: RepositoryTreeNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'file') {
      if (child.path.toLowerCase().includes(needle)) children.push(child);
    } else {
      const filtered = filterTree(child, needle);
      if (filtered) children.push(filtered);
    }
  }
  if (children.length === 0) return null;
  const fileCount = children.reduce((sum, c) => sum + (c.kind === 'file' ? 1 : c.fileCount), 0);
  return { ...node, children, fileCount };
}
