import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_INFO } from '../../core/repository/fileTypes';
import { ancestorFolders, buildRepositoryTree, filterTree } from '../../core/repository/tree';
import type { FileStatus } from '../../core/prepare/preparation';
import type { FolderNode, RepositoryFile, RepositoryTreeNode } from '../../core/repository/types';
import { Icon } from '../common/Icon';
import './FileExplorer.css';

export interface FileExplorerProps {
  readonly files: readonly RepositoryFile[];
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  /** Preparation state of each file, when known. */
  readonly statuses?: ReadonlyMap<string, FileStatus>;
}

/**
 * Repository file tree. Shows every file in the project — supported or not —
 * with its original name and position in the folder structure.
 */
export function FileExplorer({ files, selectedPath, onSelect, statuses }: FileExplorerProps) {
  const tree = useMemo(() => buildRepositoryTree(files), [files]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(topLevelFolders(tree)));

  // Reveal the selected file whenever it changes (e.g. via a deep link).
  useEffect(() => {
    if (!selectedPath) return;
    setExpanded((prev) => {
      const ancestors = ancestorFolders(selectedPath);
      if (ancestors.every((a) => prev.has(a))) return prev;
      return new Set([...prev, ...ancestors]);
    });
  }, [selectedPath]);

  const visibleTree = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = query.trim().length > 0;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="file-explorer">
      <div className="file-explorer__search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Filter files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter files by path"
          spellCheck={false}
        />
      </div>
      <div className="file-explorer__summary">
        {filtering && visibleTree
          ? `${visibleTree.fileCount} of ${tree.fileCount} files match`
          : `${tree.fileCount} ${tree.fileCount === 1 ? 'file' : 'files'}`}
      </div>
      {visibleTree ? (
        <ul className="file-tree" role="tree" aria-label="Repository files">
          {visibleTree.children.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              forceExpanded={filtering}
              selectedPath={selectedPath}
              onToggle={toggle}
              onSelect={onSelect}
              statuses={statuses}
            />
          ))}
        </ul>
      ) : (
        <p className="file-explorer__empty">No files match “{query}”.</p>
      )}
    </div>
  );
}

function topLevelFolders(tree: FolderNode): string[] {
  return tree.children.filter((c) => c.kind === 'folder').map((c) => c.path);
}

interface TreeNodeProps {
  readonly node: RepositoryTreeNode;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly forceExpanded: boolean;
  readonly selectedPath: string | null;
  readonly onToggle: (path: string) => void;
  readonly onSelect: (path: string) => void;
  readonly statuses: ReadonlyMap<string, FileStatus> | undefined;
}

/** Folders with more entries than this show the rest on request, so a huge folder does not slow the page down. */
const FOLDER_PAGE = 300;

function TreeNode({ node, depth, expanded, forceExpanded, selectedPath, onToggle, onSelect, statuses }: TreeNodeProps) {
  const [shown, setShown] = useState(FOLDER_PAGE);
  const indent = { paddingLeft: `${8 + depth * 14}px` };

  if (node.kind === 'file') {
    const info = CATEGORY_INFO[node.file.category];
    const selected = node.path === selectedPath;
    const status = statuses?.get(node.path);
    const mark = status && status.state !== 'prepared' && status.state !== 'unsupported' ? status.state : null;
    return (
      <li role="treeitem" aria-selected={selected} className="file-tree__item">
        <button
          type="button"
          className="file-tree__row file-tree__row--file"
          style={indent}
          onClick={() => onSelect(node.path)}
          aria-current={selected ? 'page' : undefined}
          title={`${node.path} · ${info.label} · ${formatBytes(node.file.size)}`}
        >
          <span className="file-badge" style={{ color: `var(${info.colorVar})` }}>
            {info.badge}
          </span>
          <span className="file-tree__name">{node.name}</span>
          {mark ? (
            <span className={`file-tree__state status-dot is-${mark}`} title={status?.reason ?? mark}>
              {mark === 'failed' ? '✗' : mark === 'processing' ? '◐' : '○'}
            </span>
          ) : null}
          {node.file.category === 'other' ? (
            <span className="file-tree__flag" title="Unsupported file type — metadata only">
              unsupported
            </span>
          ) : null}
        </button>
      </li>
    );
  }

  const isOpen = forceExpanded || expanded.has(node.path);
  return (
    <li role="treeitem" aria-expanded={isOpen} aria-selected={false} className="file-tree__item">
      <button type="button" className="file-tree__row file-tree__row--folder" style={indent} onClick={() => onToggle(node.path)}>
        <Icon name="chevronRight" className={isOpen ? 'file-tree__chevron is-open' : 'file-tree__chevron'} />
        <Icon name={isOpen ? 'folderOpen' : 'folder'} className="file-tree__folder-icon" />
        <span className="file-tree__name">{node.name}</span>
        <span className="file-tree__count">{node.fileCount}</span>
      </button>
      {isOpen ? (
        <ul role="group" className="file-tree">
          {node.children.slice(0, shown).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              forceExpanded={forceExpanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
              statuses={statuses}
            />
          ))}
          {node.children.length > shown ? (
            <li role="none">
              <button type="button" className="file-tree__row" style={{ paddingLeft: `${22 + depth * 14}px` }} onClick={() => setShown(shown + 1000)}>
                show {node.children.length - shown} more…
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
