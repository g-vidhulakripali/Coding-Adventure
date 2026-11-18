/**
 * Source locations.
 *
 * Every visual operation, explanation and outline entry must be traceable to
 * an exact location in the ORIGINAL file. These types are the shared currency
 * for that traceability across parser, analysis, simulation and UI.
 *
 * Conventions:
 *  - Lines are 1-based (as shown in the line-number gutter).
 *  - Columns are 0-based UTF-16 offsets within the line (as used by
 *    JavaScript strings and CodeMirror). `endColumn` is exclusive.
 */

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface SourceSpan extends LineRange {
  /** Repository-relative path of the file the span belongs to. */
  readonly path: string;
  /** When present together with `endColumn`, the span covers an exact expression, not whole lines. */
  readonly startColumn?: number;
  readonly endColumn?: number;
}

/** Parses `"12"` or `"12-18"` (as used in workspace URLs) into a line range. */
export function parseLineRange(value: string | null | undefined): LineRange | null {
  if (!value) return null;
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { startLine: start, endLine: end };
}

export function formatLineRange(range: LineRange): string {
  return range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
}
