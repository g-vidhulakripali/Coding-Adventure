import { ANALYSIS_VERSION, type FileAnalysis } from '../analysis/python/fileAnalysis';
import { checkPath, IMPORT_LIMITS } from '../import/limits';
import { readZip, ZipError, type ZipEntry } from '../import/zip';
import { ZipWriter } from '../import/zipWriter';
import { detectCategory, fileNameOf } from '../repository/fileTypes';
import type { LeftOut, RepositoryFile } from '../repository/types';
import { write } from './database';
import { checkSpace, loadAnalyses, readBlob, readRecord, type ProjectRecord } from './storage';

/**
 * Backups: one ZIP with the original files and the prepared results of one or more
 * projects. A backup that comes back is untrusted like any upload: paths, sizes and
 * the stored results are checked before anything is kept.
 */

export const MANIFEST = 'code-playground.json';
const FORMAT = 1;

interface ManifestProject {
  readonly dir: string;
  readonly name: string;
  readonly savedAt: number;
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number; readonly note?: string }>;
  readonly leftOut: LeftOut;
}

export async function exportProjects(ids: readonly string[], onProgress: (done: number, total: number) => void): Promise<Blob> {
  const zip = new ZipWriter();
  const projects: ManifestProject[] = [];
  const records: ProjectRecord[] = [];
  for (const id of ids) {
    const r = await readRecord(id);
    if (r && r.status !== 'importing') records.push(r);
  }
  if (records.length === 0) throw new Error('There is no complete project to export.');
  const total = records.reduce((n, r) => n + r.files.length, 0);
  let done = 0;
  for (const [i, r] of records.entries()) {
    const dir = `project-${i + 1}`;
    for (const f of r.files) {
      const blob = await readBlob(r.id, f.path);
      if (blob) await zip.add(`${dir}/files/${f.path}`, blob);
      onProgress(++done, total);
    }
    const analyses = [...(await loadAnalyses(r.id)).values()];
    if (analyses.length > 0) await zip.add(`${dir}/prepared.json`, JSON.stringify(analyses));
    projects.push({ dir, name: r.name, savedAt: r.savedAt, files: r.files.map((f) => ({ path: f.path, size: f.size, ...(f.note ? { note: f.note } : {}) })), leftOut: r.leftOut });
  }
  await zip.add(MANIFEST, JSON.stringify({ format: FORMAT, app: 'code-playground', analysisVersion: ANALYSIS_VERSION, projects }));
  return zip.finish();
}

export function isBackup(entries: readonly ZipEntry[]): boolean {
  return entries.some((e) => e.rawPath === MANIFEST);
}

const isText = (v: unknown): v is string => typeof v === 'string';

function readManifest(text: string): ManifestProject[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ZipError('The backup is damaged (its description is unreadable).');
  }
  const m = data as { format?: unknown; app?: unknown; projects?: unknown };
  if (m.app !== 'code-playground' || !Array.isArray(m.projects)) throw new ZipError('This is not a Code Playground backup.');
  if (m.format !== FORMAT) throw new ZipError('This backup was made by a different version of the app and cannot be read.');
  return m.projects.map((p: Partial<ManifestProject>) => {
    if (!p || !isText(p.dir) || !/^project-\d+$/.test(p.dir) || !isText(p.name) || !Array.isArray(p.files)) throw new ZipError('The backup is damaged (a project is incomplete).');
    const folders = Array.isArray(p.leftOut?.folders) ? p.leftOut.folders.filter((f) => isText(f?.path)).map((f) => ({ path: f.path, files: Number(f.files) || 0, bytes: Number(f.bytes) || 0 })) : [];
    const refused = Array.isArray(p.leftOut?.refused) ? p.leftOut.refused.filter((f) => isText(f?.path) && isText(f?.reason)) : [];
    return { dir: p.dir, name: p.name.slice(0, 200), savedAt: Number(p.savedAt) || Date.now(), files: p.files.filter((f) => isText(f?.path)), leftOut: { folders, refused } };
  });
}

/** Stored results are used only when they are complete and belong to a file of the backup. */
export function usableAnalysis(a: unknown, paths: ReadonlySet<string>): a is FileAnalysis {
  const x = a as Partial<FileAnalysis> | null;
  return (
    !!x &&
    x.version === ANALYSIS_VERSION &&
    isText(x.path) &&
    paths.has(x.path) &&
    typeof x.sourceLength === 'number' &&
    typeof x.lines === 'number' &&
    Array.isArray(x.uses) &&
    Array.isArray(x.paths) &&
    Array.isArray(x.constants) &&
    Array.isArray(x.scenarios) &&
    Array.isArray(x.models) &&
    !!x.calls &&
    x.calls.path === x.path &&
    Array.isArray(x.calls.definitions) &&
    Array.isArray(x.calls.calls) &&
    Array.isArray(x.calls.imports) &&
    x.calls.calls.every((c) => isText(c?.callee) && typeof c?.span?.startLine === 'number' && c.path === x.path) &&
    x.calls.definitions.every((d) => isText(d?.id) && isText(d?.qualname) && typeof d?.span?.startLine === 'number') &&
    !!x.coverage &&
    Array.isArray(x.coverage.gaps) &&
    typeof x.coverage.counts === 'object'
  );
}

/** Restores every project of a backup as a new project. Returns their ids. */
export async function importBackup(file: File, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<string[]> {
  const entries = await readZip(file);
  const byPath = new Map(entries.filter((e) => !e.isDirectory).map((e) => [e.rawPath, e]));
  const entry = byPath.get(MANIFEST);
  if (!entry || entry.size > 64 * 1024 ** 2) throw new ZipError('This is not a Code Playground backup.');
  const projects = readManifest(await (await entry.extract()).text());
  const total = projects.reduce((n, p) => n + p.files.length, 0);
  if (total > IMPORT_LIMITS.files * 5) throw new ZipError('The backup lists more files than this app keeps.');
  const space = await checkSpace(entries.reduce((n, e) => n + e.size, 0));
  if (space.verdict === 'too-large') throw new Error('There is not enough free browser storage for this backup.');
  const ids: string[] = [];
  let done = 0;
  try {
    for (const p of projects) {
      const id = crypto.randomUUID();
      ids.push(id);
      const files: RepositoryFile[] = [];
      const refused = [...p.leftOut.refused];
      let bytes = 0;
      for (const f of p.files) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        onProgress(++done, total);
        const check = checkPath(f.path);
        if (!check.ok || check.path !== f.path) {
          refused.push({ path: String(f.path).slice(0, 200), reason: check.ok ? 'the path is not plain' : check.reason });
          continue;
        }
        const e = byPath.get(`${p.dir}/files/${f.path}`);
        const base = { path: f.path, name: fileNameOf(f.path), category: detectCategory(f.path) };
        if (!e) {
          files.push({ ...base, size: Number(f.size) || 0, note: isText(f.note) ? f.note.slice(0, 200) : 'Not stored in the backup.' });
          continue;
        }
        if (e.problem || e.size > IMPORT_LIMITS.fileBytes || bytes + e.size > IMPORT_LIMITS.totalBytes) {
          refused.push({ path: f.path, reason: e.problem ?? 'it is too large' });
          continue;
        }
        const blob = await e.extract();
        bytes += blob.size;
        files.push({ ...base, size: blob.size });
        await write('files', (tx) => tx.objectStore('files').put(blob, [id, f.path]));
      }
      const stored = byPath.get(`${p.dir}/prepared.json`);
      if (stored && stored.size < 512 * 1024 ** 2 && !stored.problem) {
        const paths = new Set(files.map((f) => f.path));
        let list: unknown = null;
        try {
          list = JSON.parse(await (await stored.extract()).text());
        } catch {
          // Without prepared results the project is prepared again when it is opened.
        }
        if (Array.isArray(list)) {
          const good = list.filter((a) => usableAnalysis(a, paths));
          if (good.length > 0)
            await write('analysis', (tx) => {
              for (const a of good) tx.objectStore('analysis').put(a, [id, a.path]);
            });
        }
      }
      const record: ProjectRecord = { id, name: p.name, savedAt: Date.now(), bytes, files, leftOut: { folders: p.leftOut.folders, refused }, status: 'ready' };
      await write('projects', (tx) => tx.objectStore('projects').put(record));
    }
  } catch (err) {
    const { removeProject } = await import('./storage');
    for (const id of ids) await removeProject(id).catch(() => undefined);
    throw err;
  }
  return ids;
}
