/**
 * Limits for imported repositories. Uploads are untrusted: every limit is
 * checked before data is kept, and everything left out is reported.
 */
export const IMPORT_LIMITS = {
  /** Largest ZIP file that is opened. */
  archiveBytes: 1024 ** 3,
  /** Largest amount of unpacked data kept per project. */
  totalBytes: 2 * 1024 ** 3,
  /** Larger files are listed but their content is not stored. */
  fileBytes: 100 * 1024 ** 2,
  files: 20_000,
  pathLength: 512,
  depth: 40,
  /** Unpacked/packed ratio above which a large entry is treated as a ZIP bomb. */
  ratio: 200,
  ratioMinBytes: 5 * 1024 ** 2,
} as const;

/** Analysis and preview limits (files above them stay in the project, unread). */
export const ANALYSIS_LIMITS = {
  pythonFileBytes: 2 * 1024 ** 2,
  pythonTotalBytes: 40 * 1024 ** 2,
  csvFileBytes: 2 * 1024 ** 2,
  csvTotalBytes: 20 * 1024 ** 2,
  viewerBytes: 5 * 1024 ** 2,
} as const;

/** Folders that hold tools, caches or history rather than the project's own code. */
const LEFT_OUT = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', 'venv', 'site-packages', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.ipynb_checkpoints', '.tox', '.nox', '.eggs', '.cache', '__MACOSX']);

export function isLeftOutFolder(name: string): boolean {
  return LEFT_OUT.has(name) || name.startsWith('.venv');
}

/** The outermost left-out folder containing `path`, or null. */
export function leftOutFolderOf(path: string): string | null {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (isLeftOutFolder(parts[i]!)) return parts.slice(0, i + 1).join('/');
  return null;
}

export type PathCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * Accepts only plain relative paths. A path is never rewritten into something
 * it was not: `..`, absolute paths and drive letters are refused, not repaired.
 * (Backslashes are the separator in ZIPs made by some Windows tools.)
 */
export function checkPath(raw: string): PathCheck {
  const path = raw.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'the name contains control characters' };
  if (/[‪-‮⁦-⁩]/.test(path)) return { ok: false, reason: 'the name contains text-direction tricks' };
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return { ok: false, reason: 'the path is absolute' };
  if (path.length === 0 || path.length > IMPORT_LIMITS.pathLength) return { ok: false, reason: 'the path is empty or too long' };
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'the path climbs out of the project (..)' };
  if (parts.some((p) => p === '' || p === '.')) return { ok: false, reason: 'the path is malformed' };
  if (parts.length > IMPORT_LIMITS.depth) return { ok: false, reason: 'the folders are nested too deeply' };
  return { ok: true, path };
}
