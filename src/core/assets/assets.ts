import type { FileAnalysis } from '../analysis/python/fileAnalysis';
import type { FileCategory, RepositoryFile } from '../repository/types';

/**
 * Where files such as images, data and configuration are mentioned. A mention is
 * certain only when a complete path written in the code leads to exactly one file.
 */

export interface PathMention {
  readonly text: string;
  readonly path: string;
  readonly line: number;
  /** False when the text is only part of a path put together at runtime. */
  readonly whole: boolean;
}

export interface AssetReference {
  readonly mention: PathMention;
  readonly certainty: 'certain' | 'likely' | 'unclear';
  readonly reason: string;
}

export interface Asset {
  readonly file: RepositoryFile;
  readonly group: 'image' | 'data' | 'configuration' | 'document' | 'other';
  readonly references: readonly AssetReference[];
}

export interface AssetReport {
  readonly assets: readonly Asset[];
  /** Mentions that look like project files but lead nowhere. */
  readonly unresolved: ReadonlyArray<{ readonly mention: PathMention; readonly reason: string }>;
}

const GROUP: Partial<Record<FileCategory, Asset['group']>> = { image: 'image', svg: 'image', csv: 'data', json: 'configuration', yaml: 'configuration', toml: 'configuration', 'dependency-manifest': 'configuration', markdown: 'document', text: 'document', html: 'document', css: 'document', other: 'other' };
const LISTED: ReadonlySet<string> = new Set('png jpg jpeg gif webp bmp ico avif svg csv tsv json yaml yml toml md txt html htm css parquet xlsx xls h5 hdf5 npy npz pkl joblib db sqlite zip gz pdf ttf otf woff woff2 mp3 wav mp4 ini cfg feather mat pt pth onnx'.split(' '));

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function normalise(p: string): string | null {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

export function mentionsIn(analyses: Iterable<FileAnalysis>): PathMention[] {
  const out: PathMention[] = [];
  for (const a of analyses) for (const p of a.paths) out.push({ text: p.value, path: a.path, line: p.line, whole: p.whole });
  return out;
}

/** Links and images of a Markdown text. */
export function markdownMentions(path: string, text: string): PathMention[] {
  const out: PathMention[] = [];
  let code = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) code = !code;
    if (code) return;
    for (const m of l.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) add(out, path, m[1]!, i + 1);
    for (const m of l.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(out, path, m[1]!, i + 1);
  });
  return out;
}

/** Links of an HTML page, read with the browser's inert parser (nothing is loaded or run). */
export function htmlMentions(path: string, text: string): PathMention[] {
  const out: PathMention[] = [];
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const lines = text.split('\n');
  for (const el of doc.querySelectorAll('[src], link[href], a[href]')) {
    const value = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
    const line = lines.findIndex((l) => l.includes(value));
    add(out, path, value, line < 0 ? 1 : line + 1);
  }
  return out;
}

/** `url(…)`, `@import` (CSS), and `import`/`require` of relative files (JavaScript). */
export function styleAndScriptMentions(path: string, text: string): PathMention[] {
  const out: PathMention[] = [];
  const css = /\.css$/i.test(path);
  text.split('\n').forEach((l, i) => {
    const found = css ? [...l.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g), ...l.matchAll(/@import\s+["']([^"']+)["']/g)] : [...l.matchAll(/(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)["'](\.{1,2}\/[^"']+)["']/g)];
    for (const m of found) add(out, path, m[1]!, i + 1);
  });
  return out;
}

function add(out: PathMention[], path: string, value: string, line: number) {
  const clean = value.split(/[?#]/)[0]!;
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//') || clean.length > 260) return;
  let text = clean;
  try {
    text = decodeURIComponent(clean);
  } catch {
    // Not percent-encoded after all.
  }
  out.push({ text, path, line, whole: true });
}

export function findAssets(files: readonly RepositoryFile[], mentions: readonly PathMention[]): AssetReport {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const list = byName.get(f.name);
    if (list) list.push(f.path);
    else byName.set(f.name, [f.path]);
  }
  const references = new Map<string, AssetReference[]>();
  const unresolved: Array<{ mention: PathMention; reason: string }> = [];
  const refer = (file: string, r: AssetReference) => {
    const list = references.get(file);
    if (list) list.push(r);
    else references.set(file, [r]);
  };

  for (const m of mentions) {
    // Relative to the file that mentions it, to each folder above it, and to the root.
    const bases: string[] = [];
    for (let dir = dirname(m.path); ; dir = dirname(dir)) {
      bases.push(dir);
      if (!dir) break;
    }
    const exact = m.text.startsWith('/') ? null : bases.map((b) => normalise(`${b}/${m.text}`)).find((p): p is string => !!p && byPath.has(p));
    if (exact && m.whole) {
      refer(exact, { mention: m, certainty: 'certain', reason: normalise(`${dirname(m.path)}/${m.text}`) === exact ? 'The path leads to this file.' : 'The path leads to this file when the program runs in a folder above.' });
      continue;
    }
    const name = basename(m.text.replace(/\\/g, '/'));
    const same = byName.get(name) ?? [];
    if (same.length === 1) refer(same[0]!, { mention: m, certainty: 'likely', reason: m.whole ? 'Only the file name matches; the folder is different.' : 'The path is put together at runtime; this is the only file with that name.' });
    else if (same.length > 1) for (const p of same.slice(0, 5)) refer(p, { mention: m, certainty: 'unclear', reason: `${same.length} files have this name.` });
    else {
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      if (LISTED.has(ext) && name.includes('.')) unresolved.push({ mention: m, reason: m.whole ? 'No file of the project has this path. It may be made or found at runtime.' : 'Part of a path that is put together at runtime.' });
    }
  }
  const assets = files
    .filter((f) => GROUP[f.category])
    .map((file): Asset => ({ file, group: GROUP[file.category]!, references: references.get(file.path) ?? [] }))
    .sort((a, b) => a.file.path.localeCompare(b.file.path));
  return { assets, unresolved };
}
