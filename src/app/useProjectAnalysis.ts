import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileAnalysis } from '../core/analysis/python/fileAnalysis';
import { ProjectIndex } from '../core/analysis/python/projectIndex';
import { ANALYSIS_LIMITS } from '../core/import/limits';
import { Preparation, type FileStatus, type PreparationSnapshot } from '../core/prepare/preparation';
import { notebookToPython, type NotebookText } from '../core/repository/notebook';
import type { ProjectSource, RepositoryFile } from '../core/repository/types';
import { AnalysisPool } from '../workers/analysisPool';

export interface ProjectAnalysis {
  /** Python text for the analysis (uniform line endings; notebooks as Python), or null while reading. */
  readonly sources: ReadonlyMap<string, string> | null;
  readonly dataFiles: ReadonlyMap<string, string> | null;
  readonly notebooks: ReadonlyMap<string, NotebookText>;
  readonly analyses: ReadonlyMap<string, FileAnalysis>;
  readonly index: ProjectIndex | null;
  readonly statuses: ReadonlyMap<string, FileStatus>;
  readonly snapshot: PreparationSnapshot | null;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly cancel: () => void;
  readonly restart: () => void;
}

export function normaliseNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

const NONE = new Map<string, never>();
/** Linking all files again and again would be slow in a large project; this is often enough to watch it grow. */
const LINK_EVERY_MS = 1500;

/** Reads a project's code, prepares it in the background, and connects the files. */
export function useProjectAnalysis(project: ProjectSource | null, currentFile: string | null): ProjectAnalysis {
  const [sources, setSources] = useState<ReadonlyMap<string, string> | null>(null);
  const [dataFiles, setDataFiles] = useState<ReadonlyMap<string, string> | null>(null);
  const [notebooks, setNotebooks] = useState<ReadonlyMap<string, NotebookText>>(NONE);
  const [tick, setTick] = useState(0);
  const [round, setRound] = useState(0);
  const prep = useRef<Preparation | null>(null);
  const [analyses, setAnalyses] = useState<ReadonlyMap<string, FileAnalysis>>(NONE);
  const first = useRef(currentFile);
  first.current = currentFile;

  useEffect(() => {
    setSources(null);
    setDataFiles(null);
    setNotebooks(NONE);
    setAnalyses(NONE);
    prep.current = null;
    if (!project) return;
    let cancelled = false;
    let pool: AnalysisPool | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const excluded = new Map<string, string>();
    const nb = new Map<string, NotebookText>();

    const read = async (wanted: (f: RepositoryFile) => boolean, fileLimit: number, totalLimit: number) => {
      const out = new Map<string, string>();
      let total = 0;
      for (const f of project.files) {
        if (!wanted(f) || cancelled) continue;
        if (f.size > fileLimit || total + f.size > totalLimit) {
          excluded.set(f.path, f.size > fileLimit ? `Too large to analyse (limit ${Math.round(fileLimit / 1024 ** 2)} MB). The file itself is kept.` : 'The project has more code than is analysed at once. The file itself is kept.');
          continue;
        }
        total += f.size;
        try {
          // The analysis copy has uniform line endings; the original file stays as it is.
          const text = normaliseNewlines(await project.readText(f.path));
          if (f.category === 'notebook') {
            const converted = notebookToPython(text);
            nb.set(f.path, converted);
            if (converted.language === 'python') out.set(f.path, converted.source);
            else excluded.set(f.path, `The notebook's language is ${converted.language}; only Python is analysed.`);
          } else out.set(f.path, text);
        } catch (err) {
          excluded.set(f.path, err instanceof Error ? err.message : String(err));
        }
      }
      return out;
    };

    void (async () => {
      const py = await read((f) => f.category === 'python' || f.category === 'notebook' || f.name === 'setup.py', ANALYSIS_LIMITS.pythonFileBytes, ANALYSIS_LIMITS.pythonTotalBytes);
      const notPython = new Map(excluded);
      const csv = await read((f) => f.category === 'csv', ANALYSIS_LIMITS.csvFileBytes, ANALYSIS_LIMITS.csvTotalBytes);
      if (cancelled) return;
      setDataFiles(csv);
      setNotebooks(nb);
      setSources(py);
      pool = new AnalysisPool();
      const current = new Preparation({
        files: project.files,
        sources: py,
        excluded: notPython,
        concurrency: pool.size,
        analyse: (path, source) => pool!.analyse(path, source),
        loadStored: () => project.analysisStore?.load() ?? Promise.resolve(new Map()),
        save: (a) => project.analysisStore?.save(a) ?? Promise.resolve(),
        onChange: () => {
          if (cancelled || timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            if (!cancelled) setTick((n) => n + 1);
          }, 120);
        },
      });
      prep.current = current;
      await current.start(first.current);
    })();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      prep.current?.cancel();
      pool?.close();
    };
  }, [project, round]);

  // The open file jumps the queue.
  useEffect(() => {
    if (currentFile) prep.current?.prioritise(currentFile);
  }, [currentFile]);

  const snapshot = useMemo(() => prep.current?.snapshot() ?? null, [tick, sources]);
  const finished = snapshot !== null && snapshot.state !== 'running';

  // Publish new results now and then while working, and all of them at the end.
  const published = useRef(0);
  useEffect(() => {
    const p = prep.current;
    if (!p || p.results.size === analyses.size) return;
    const now = performance.now();
    if (!finished && analyses.size > 0 && now - published.current < LINK_EVERY_MS) return;
    published.current = now;
    setAnalyses(new Map(p.results));
  }, [tick, finished, analyses.size]);

  const index = useMemo(() => (analyses.size > 0 && (finished || analyses.size < 400) ? new ProjectIndex(analyses) : null), [analyses, finished]);

  const pause = useCallback(() => prep.current?.pause(), []);
  const resume = useCallback(() => prep.current?.resume(), []);
  const cancel = useCallback(() => prep.current?.cancel(), []);
  const restart = useCallback(() => setRound((n) => n + 1), []);
  const statuses = useMemo<ReadonlyMap<string, FileStatus>>(() => new Map(prep.current?.statuses ?? []), [tick, sources]);

  return { sources, dataFiles, notebooks, analyses, index, statuses, snapshot, pause, resume, cancel, restart };
}
