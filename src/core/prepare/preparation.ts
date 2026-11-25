import { ANALYSIS_VERSION, type FileAnalysis } from '../analysis/python/fileAnalysis';
import type { RepositoryFile } from '../repository/types';

/**
 * Prepares a project file by file: takes stored results where they still fit, and
 * analyses the rest in the background. Can be paused, resumed and cancelled; every
 * finished file is stored at once, so an interruption loses only the files in work.
 */

export type FileState = 'waiting' | 'processing' | 'prepared' | 'failed' | 'unsupported';

export interface FileStatus {
  readonly state: FileState;
  readonly reason?: string;
  /** True when the stored result of an earlier visit was used. */
  readonly stored?: boolean;
}

export interface PreparationSnapshot {
  readonly state: 'running' | 'paused' | 'cancelled' | 'done';
  readonly total: number;
  readonly prepared: number;
  readonly remaining: number;
  readonly failed: number;
  readonly unsupported: number;
  readonly stored: number;
  readonly current: readonly string[];
  readonly elapsedMs: number;
  /** Null until there are enough measurements. */
  readonly etaMs: number | null;
}

export interface PreparationOptions {
  readonly files: readonly RepositoryFile[];
  /** Python text (analysis copies) by path. */
  readonly sources: ReadonlyMap<string, string>;
  /** Files that cannot be analysed, with the reason. */
  readonly excluded: ReadonlyMap<string, string>;
  readonly concurrency: number;
  readonly analyse: (path: string, source: string) => Promise<FileAnalysis>;
  readonly loadStored: () => Promise<ReadonlyMap<string, FileAnalysis>>;
  readonly save: (analysis: FileAnalysis) => Promise<void>;
  readonly onChange: () => void;
  readonly now?: () => number;
}

const MIN_ETA_FILES = 5;
const MIN_ETA_MS = 1500;

/** Stored results fit when they come from the same analysis version and the same text length. */
export function fits(stored: FileAnalysis | undefined, source: string): stored is FileAnalysis {
  return !!stored && stored.version === ANALYSIS_VERSION && stored.sourceLength === source.length;
}

export class Preparation {
  readonly results = new Map<string, FileAnalysis>();
  readonly statuses = new Map<string, FileStatus>();
  private state: PreparationSnapshot['state'] = 'running';
  private queue: string[] = [];
  private readonly active = new Set<string>();
  private started = 0;
  private pausedAt = 0;
  private pausedFor = 0;
  private finishedAt = 0;
  private analysedFiles = 0;
  private analysedChars = 0;
  private readonly now: () => number;

  constructor(private readonly o: PreparationOptions) {
    this.now = o.now ?? (() => performance.now());
    for (const f of o.files) {
      const excluded = o.excluded.get(f.path);
      this.statuses.set(
        f.path,
        excluded !== undefined ? { state: 'failed', reason: excluded } : o.sources.has(f.path) ? { state: 'waiting' } : f.category === 'other' ? { state: 'unsupported', reason: f.note ?? 'Kept and listed; there is no viewer for this file type.' } : { state: 'prepared' },
      );
    }
  }

  async start(first: string | null = null): Promise<void> {
    this.started = this.now();
    let stored: ReadonlyMap<string, FileAnalysis> = new Map();
    try {
      stored = await this.o.loadStored();
    } catch {
      // Without stored results everything is analysed again; nothing is lost.
    }
    if (this.state === 'cancelled') return;
    for (const [path, source] of this.o.sources) {
      const s = stored.get(path);
      if (fits(s, source)) {
        this.results.set(path, s);
        this.statuses.set(path, { state: 'prepared', stored: true });
      } else this.queue.push(path);
    }
    // The open file first, then small files: something useful is ready soon.
    const size = (p: string) => this.o.sources.get(p)!.length;
    this.queue.sort((a, b) => (a === first ? -1 : b === first ? 1 : size(a) - size(b)));
    this.o.onChange();
    this.pump();
  }

  /** Moves a file to the front, e.g. because the user opened it. */
  prioritise(path: string) {
    const at = this.queue.indexOf(path);
    if (at > 0) {
      this.queue.splice(at, 1);
      this.queue.unshift(path);
    }
  }

  private pump() {
    if (this.state !== 'running') return;
    while (this.active.size < this.o.concurrency && this.queue.length > 0) void this.one(this.queue.shift()!);
    if (this.active.size === 0 && this.queue.length === 0) {
      this.state = 'done';
      this.finishedAt = this.now();
      this.o.onChange();
    }
  }

  private async one(path: string) {
    this.active.add(path);
    this.statuses.set(path, { state: 'processing' });
    this.o.onChange();
    const source = this.o.sources.get(path)!;
    try {
      const analysis = await this.o.analyse(path, source);
      this.results.set(path, analysis);
      this.statuses.set(path, { state: 'prepared' });
      this.analysedFiles++;
      this.analysedChars += source.length;
      await this.o.save(analysis).catch(() => undefined);
    } catch (err) {
      // Cancelled work is waiting again, not failed.
      this.statuses.set(path, this.isCancelled() ? { state: 'waiting' } : { state: 'failed', reason: err instanceof Error ? err.message : String(err) });
    }
    this.active.delete(path);
    this.o.onChange();
    this.pump();
  }

  private isCancelled(): boolean {
    return this.state === 'cancelled';
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.pausedAt = this.now();
    this.o.onChange();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pausedFor += this.now() - this.pausedAt;
    this.state = 'running';
    this.o.onChange();
    this.pump();
  }

  cancel() {
    if (this.state === 'done') return;
    this.state = 'cancelled';
    this.finishedAt = this.now();
    this.o.onChange();
  }

  snapshot(): PreparationSnapshot {
    let prepared = 0;
    let failed = 0;
    let unsupported = 0;
    let stored = 0;
    for (const s of this.statuses.values()) {
      if (s.state === 'prepared') prepared++;
      else if (s.state === 'failed') failed++;
      else if (s.state === 'unsupported') unsupported++;
      if (s.stored) stored++;
    }
    const end = this.finishedAt || (this.state === 'paused' ? this.pausedAt : this.now());
    const elapsedMs = this.started ? end - this.started - this.pausedFor : 0;
    const left = [...this.queue, ...this.active].reduce((n, p) => n + this.o.sources.get(p)!.length, 0);
    const enough = this.state === 'running' && this.analysedFiles >= MIN_ETA_FILES && elapsedMs >= MIN_ETA_MS && this.analysedChars > 0;
    return {
      state: this.state,
      total: this.statuses.size,
      prepared,
      failed,
      unsupported,
      stored,
      remaining: this.queue.length + this.active.size,
      current: [...this.active],
      elapsedMs,
      etaMs: enough ? (left * elapsedMs) / this.analysedChars : null,
    };
  }
}
