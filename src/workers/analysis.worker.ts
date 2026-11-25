/// <reference lib="webworker" />
import pythonWasm from 'tree-sitter-python/tree-sitter-python.wasm?url';
import runtimeWasm from 'web-tree-sitter/tree-sitter.wasm?url';
import { analysePythonFile, type FileAnalysis } from '../core/analysis/python/fileAnalysis';
import { compareStructures, loadTreeSitter, treeSitterStructure, type ParserCheck } from '../core/parser/python/treeSitter';

export interface AnalysisRequest {
  readonly id: number;
  readonly path: string;
  readonly source: string;
}
export type AnalysisReply = { readonly id: number; readonly analysis: FileAnalysis } | { readonly id: number; readonly error: string };

/** Analyses one file at a time, away from the page, so the interface stays responsive. */
self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, path, source } = e.data;
  void (async () => {
    let reply: AnalysisReply;
    try {
      const analysis = analysePythonFile(path, source);
      let check: ParserCheck | null = null;
      try {
        const parser = await loadTreeSitter({ runtime: new URL(runtimeWasm, self.location.href).href, python: new URL(pythonWasm, self.location.href).href });
        check = compareStructures(analysis.structure, treeSitterStructure(parser, source));
      } catch {
        // The second parser is a cross-check; without it the analysis still holds (and says it was not checked).
      }
      reply = { id, analysis: { ...analysis, check } };
    } catch (err) {
      reply = { id, error: err instanceof Error ? err.message : String(err) };
    }
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);
  })();
};
