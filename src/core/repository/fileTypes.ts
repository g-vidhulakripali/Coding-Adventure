import type { FileCategory } from './types';

/**
 * File-category detection by name and extension.
 *
 * Phase 1 uses names only. Phase 4 (ZIP import) adds content sniffing so a file
 * whose extension lies about its content (MIME spoofing) is caught before any
 * preview is rendered.
 */

const DEPENDENCY_MANIFESTS = new Set([
  'requirements.txt',
  'requirements-dev.txt',
  'requirements_dev.txt',
  'constraints.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'environment.yml',
  'environment.yaml',
  'package.json',
]);

const EXTENSION_CATEGORIES: Record<string, FileCategory> = {
  py: 'python',
  pyi: 'python',
  ipynb: 'notebook',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  svg: 'svg',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  csv: 'csv',
  tsv: 'csv',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  rst: 'text',
  cfg: 'text',
  ini: 'text',
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
};

/** Extension-less filenames that are conventionally plain text. */
const TEXT_FILENAMES = new Set(['license', 'licence', 'copying', 'authors', 'notice', 'makefile', 'dockerfile', '.gitignore', '.env.example']);

export function fileNameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  // A leading dot (".gitignore") is not an extension separator.
  return idx <= 0 ? '' : name.slice(idx + 1).toLowerCase();
}

export function detectCategory(path: string): FileCategory {
  const name = fileNameOf(path);
  const lower = name.toLowerCase();
  if (DEPENDENCY_MANIFESTS.has(lower) || /^requirements[-_.\w]*\.txt$/.test(lower)) {
    return 'dependency-manifest';
  }
  const ext = extensionOf(name);
  const byExt = EXTENSION_CATEGORIES[ext];
  if (byExt) return byExt;
  if (TEXT_FILENAMES.has(lower)) return 'text';
  return 'other';
}

/** Categories whose content is shown as text in the code viewer. */
export function isTextCategory(category: FileCategory): boolean {
  return category !== 'image' && category !== 'other';
}

/** Syntax-highlighting language for the code viewer, or null for plain text. */
export type ViewerLanguage = 'python' | 'json' | 'markdown' | 'yaml';

export function viewerLanguageFor(path: string, category: FileCategory): ViewerLanguage | null {
  switch (category) {
    case 'python':
      return 'python';
    case 'json':
    case 'notebook':
      return 'json';
    case 'markdown':
      return 'markdown';
    case 'yaml':
      return 'yaml';
    case 'dependency-manifest': {
      const ext = extensionOf(fileNameOf(path));
      if (ext === 'py') return 'python';
      if (ext === 'json') return 'json';
      if (ext === 'yml' || ext === 'yaml') return 'yaml';
      return null;
    }
    default:
      return null;
  }
}

export interface CategoryInfo {
  /** Short badge text shown in the explorer. */
  readonly badge: string;
  readonly label: string;
  /** CSS custom property holding the category colour. */
  readonly colorVar: string;
}

export const CATEGORY_INFO: Record<FileCategory, CategoryInfo> = {
  python: { badge: 'PY', label: 'Python source', colorVar: '--cat-python' },
  notebook: { badge: 'NB', label: 'Jupyter notebook', colorVar: '--cat-notebook' },
  image: { badge: 'IMG', label: 'Image', colorVar: '--cat-image' },
  svg: { badge: 'SVG', label: 'SVG image', colorVar: '--cat-image' },
  json: { badge: '{}', label: 'JSON', colorVar: '--cat-data' },
  yaml: { badge: 'YML', label: 'YAML', colorVar: '--cat-config' },
  toml: { badge: 'TML', label: 'TOML', colorVar: '--cat-config' },
  csv: { badge: 'CSV', label: 'Tabular data', colorVar: '--cat-data' },
  markdown: { badge: 'MD', label: 'Markdown', colorVar: '--cat-doc' },
  text: { badge: 'TXT', label: 'Plain text', colorVar: '--cat-doc' },
  html: { badge: 'HTM', label: 'HTML', colorVar: '--cat-web' },
  css: { badge: 'CSS', label: 'CSS', colorVar: '--cat-web' },
  javascript: { badge: 'JS', label: 'JavaScript / TypeScript', colorVar: '--cat-web' },
  'dependency-manifest': { badge: 'DEP', label: 'Dependency manifest', colorVar: '--cat-deps' },
  other: { badge: '?', label: 'Unsupported file type', colorVar: '--cat-other' },
};
