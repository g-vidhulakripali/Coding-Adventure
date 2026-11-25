/**
 * Divides a long block of code into chapters, following the way its author wrote
 * it: a blank line or a comment between two statements starts a new one, and the
 * comment is its title. Every statement belongs to exactly one chapter.
 */

export interface ChapterSpan {
  /** The author's comment, or null. */
  readonly title: string | null;
  /** Index of the first and last statement (inclusive). */
  readonly first: number;
  readonly last: number;
  readonly startLine: number;
  readonly endLine: number;
}

/** Shorter blocks are shown as a whole. */
export const CHAPTER_MIN_LINES = 30;
export const CHAPTER_MIN_STATEMENTS = 8;
const MAX_CHAPTER_STATEMENTS = 14;

export function chaptersOf(statements: ReadonlyArray<{ readonly line: number; readonly endLine: number }>, lines: readonly string[]): ChapterSpan[] {
  const n = statements.length;
  const first = statements[0];
  const end = statements[n - 1];
  if (!first || !end || n < CHAPTER_MIN_STATEMENTS || end.endLine - first.line < CHAPTER_MIN_LINES) return [];

  const starts: Array<{ at: number; title: string | null }> = [];
  for (let i = 0; i < n; i++) {
    const from = i === 0 ? Math.max(0, first.line - 4) : statements[i - 1]!.endLine;
    const between = lines.slice(from, statements[i]!.line - 1).map((l) => l.trim());
    // The comment directly above the statement.
    const comment: string[] = [];
    for (let k = between.length - 1; k >= 0 && between[k]!.startsWith('#'); k--) comment.unshift(between[k]!.replace(/^#+[\s\-=*]*/, '').replace(/[\s\-=*]+$/, ''));
    const title = comment.join(' ').trim();
    if (i === 0 || between.some((l) => l === '') || title) starts.push({ at: i, title: title || null });
  }
  // Very small untitled groups join the one before.
  const merged = starts.filter((s, i) => i === 0 || s.title !== null || (starts[i + 1]?.at ?? n) - s.at > 2);
  const out: ChapterSpan[] = [];
  merged.forEach((s, i) => {
    const stop = (merged[i + 1]?.at ?? n) - 1;
    for (let a = s.at; a <= stop; a += MAX_CHAPTER_STATEMENTS) {
      const last = Math.min(stop, a + MAX_CHAPTER_STATEMENTS - 1);
      out.push({ title: a === s.at ? s.title : null, first: a, last, startLine: statements[a]!.line, endLine: statements[last]!.endLine });
    }
  });
  return out.length > 1 ? out : [];
}
