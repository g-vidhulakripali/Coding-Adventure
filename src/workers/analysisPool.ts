import { analysePythonFile, type FileAnalysis } from '../core/analysis/python/fileAnalysis';
import type { AnalysisReply, AnalysisRequest } from './analysis.worker';

/** A file that takes longer than this is given up (and reported), so one file cannot block the rest. */
const FILE_TIMEOUT_MS = 60_000;

interface Job {
  readonly request: AnalysisRequest;
  readonly resolve: (a: FileAnalysis) => void;
  readonly reject: (e: Error) => void;
}

/** A small, bounded pool of analysis workers. Falls back to the page itself where workers are not available. */
export class AnalysisPool {
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, { job: Job; timer: ReturnType<typeof setTimeout> }>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  readonly size: number;

  constructor(size = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))) {
    this.size = typeof Worker === 'undefined' ? 1 : size;
  }

  analyse(path: string, source: string): Promise<FileAnalysis> {
    if (typeof Worker === 'undefined') return new Promise((resolve) => setTimeout(() => resolve(analysePythonFile(path, source))));
    return new Promise((resolve, reject) => {
      this.queue.push({ request: { id: this.nextId++, path, source }, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.closed) return;
    while (this.queue.length > 0 && this.busy.size < this.size) {
      const worker = this.idle.pop() ?? this.create();
      const job = this.queue.shift()!;
      const timer = setTimeout(() => this.fail(worker, new Error('Stopped: this file took too long to analyse.')), FILE_TIMEOUT_MS);
      this.busy.set(worker, { job, timer });
      worker.postMessage(job.request);
    }
  }

  private create(): Worker {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AnalysisReply>) => {
      const entry = this.busy.get(worker);
      if (!entry || entry.job.request.id !== e.data.id) return;
      clearTimeout(entry.timer);
      this.busy.delete(worker);
      this.idle.push(worker);
      if ('analysis' in e.data) entry.job.resolve(e.data.analysis);
      else entry.job.reject(new Error(e.data.error));
      this.pump();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      this.fail(worker, new Error(e.message || 'The analysis stopped unexpectedly.'));
    };
    return worker;
  }

  /** Replaces a worker that crashed or hangs; only its current file is affected. */
  private fail(worker: Worker, error: Error) {
    const entry = this.busy.get(worker);
    worker.terminate();
    this.busy.delete(worker);
    const at = this.idle.indexOf(worker);
    if (at >= 0) this.idle.splice(at, 1);
    if (entry) {
      clearTimeout(entry.timer);
      entry.job.reject(error);
    }
    this.pump();
  }

  close() {
    this.closed = true;
    for (const w of this.idle) w.terminate();
    for (const [w, { job, timer }] of this.busy) {
      clearTimeout(timer);
      w.terminate();
      job.reject(new Error('Cancelled.'));
    }
    for (const job of this.queue) job.reject(new Error('Cancelled.'));
    this.idle.length = 0;
    this.queue.length = 0;
    this.busy.clear();
  }
}
