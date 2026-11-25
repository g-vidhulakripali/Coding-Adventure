/**
 * The ORIGINAL repository representation.
 *
 * This model mirrors the uploaded repository exactly: original paths, original
 * names, original bytes. It is deliberately kept separate from the analysis /
 * visualisation representation (see `core/analysis`), which is derived from it
 * and may be incomplete. Nothing in the analysis layer is allowed to rename,
 * rewrite or drop entries from this model.
 */

/** Broad file categories used for icons, previews and analysis routing. */
export type FileCategory =
  | 'python'
  | 'notebook'
  | 'image'
  | 'svg'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'csv'
  | 'markdown'
  | 'text'
  | 'html'
  | 'css'
  | 'javascript'
  | 'dependency-manifest'
  | 'other';

export interface RepositoryFile {
  /** Repository-relative POSIX path exactly as it appeared in the source, e.g. `analysis/usage.py`. */
  readonly path: string;
  /** Final path segment (original filename, unchanged). */
  readonly name: string;
  /** Size in bytes of the original file content. */
  readonly size: number;
  readonly category: FileCategory;
  /** Something the user should know, e.g. that the content is not stored. */
  readonly note?: string;
}

/** Everything an import did not keep, with the reason. */
export interface LeftOut {
  readonly folders: ReadonlyArray<{ readonly path: string; readonly files: number; readonly bytes: number }>;
  readonly refused: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export interface FolderNode {
  readonly kind: 'folder';
  /** Folder path without trailing slash; the root folder has path `''`. */
  readonly path: string;
  readonly name: string;
  readonly children: readonly RepositoryTreeNode[];
  /** Total number of files contained in this folder, recursively. */
  readonly fileCount: number;
}

export interface FileNode {
  readonly kind: 'file';
  readonly path: string;
  readonly name: string;
  readonly file: RepositoryFile;
}

export type RepositoryTreeNode = FolderNode | FileNode;

/** Where a project's files come from. */
export type ProjectOrigin = 'demo' | 'import';

/**
 * Read-only access to a project's original files.
 *
 * The workspace UI only talks to this interface, so the bundled demo project,
 * a freshly uploaded ZIP and a project restored from IndexedDB/OPFS can all be
 * served the same way.
 */
export interface ProjectSource {
  readonly id: string;
  readonly name: string;
  readonly origin: ProjectOrigin;
  readonly description?: string;
  readonly files: readonly RepositoryFile[];
  readonly leftOut?: LeftOut;
  /** Returns the original text of a file, or rejects if the file is unknown or not text. */
  readText(path: string): Promise<string>;
}
