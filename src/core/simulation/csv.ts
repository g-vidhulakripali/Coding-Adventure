import { UnsupportedError } from './errors';
import type { DType, PyValue } from './values';

/**
 * Reads CSV text into the simulation's DataFrame model, the way
 * `pd.read_csv` would for simple files: first row is the header, comma
 * separated, double quotes for quoting, column types inferred per column
 * (int64 → float64 → bool → object), empty cells become NaN.
 *
 * Only data is read — nothing in the file is executed.
 */

export const MAX_CSV_ROWS = 2000;

/** Splits CSV text into rows of cells (RFC 4180 style quoting). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // pandas skips completely blank lines by default.
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

function inferColumn(raw: readonly string[]): { dtype: DType; items: PyValue[] } {
  const present = raw.filter((x) => x.trim() !== '');
  const isInt = (x: string) => /^\s*[-+]?\d+\s*$/.test(x);
  const isFloat = (x: string) => /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(x) || /^\s*[-+]?(inf|nan)\s*$/i.test(x);
  const isBool = (x: string) => /^\s*(True|False|TRUE|FALSE|true|false)\s*$/.test(x);
  const hasMissing = present.length < raw.length;

  if (present.length > 0 && present.every(isInt) && !hasMissing) {
    return { dtype: 'int64', items: raw.map((x) => ({ t: 'np-scalar', dtype: 'int64', v: Number(x.trim()) })) };
  }
  if (present.length > 0 && present.every(isFloat)) {
    return { dtype: 'float64', items: raw.map((x) => ({ t: 'np-scalar', dtype: 'float64', v: x.trim() === '' ? NaN : Number(x.trim()) })) };
  }
  if (present.length > 0 && present.every(isBool) && !hasMissing) {
    return { dtype: 'bool', items: raw.map((x) => ({ t: 'np-scalar', dtype: 'bool', v: /^\s*true\s*$/i.test(x) ? 1 : 0 })) };
  }
  return { dtype: 'object', items: raw.map((x): PyValue => (x === '' ? { t: 'float', v: NaN } : { t: 'str', v: x })) };
}

export function csvToDataFrame(text: string, path: string): Extract<PyValue, { t: 'dataframe' }> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new UnsupportedError(`${path} is empty, so there is no table to read.`);
  const header = rows[0]!.map((h, i) => h.trim() || `Unnamed: ${i}`);
  const body = rows.slice(1);
  if (body.length > MAX_CSV_ROWS) {
    throw new UnsupportedError(`${path} has ${body.length} rows; the simulation reads at most ${MAX_CSV_ROWS}.`);
  }
  const columns = header.map((name, c) => ({ name, ...inferColumn(body.map((r) => r[c] ?? '')) }));
  return { t: 'dataframe', columns };
}

/** Normalises `a/./b/../c` style paths; returns null if the path climbs above the repository root. */
export function normalisePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}
