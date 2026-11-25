/**
 * Jupyter notebooks, read as data. Code cells become one Python text for the
 * analysis, with a known line for every cell. Nothing is run, and stored outputs
 * are not used as results.
 */

export interface NotebookCell {
  /** 1-based position in the notebook. */
  readonly number: number;
  readonly kind: 'code' | 'markdown' | 'raw';
  readonly text: string;
  /** Number of stored outputs (shown as a count only). */
  readonly outputs: number;
}

export interface NotebookText {
  readonly source: string;
  /** Line range of every cell in `source`. */
  readonly cells: ReadonlyArray<{ readonly number: number; readonly kind: NotebookCell['kind']; readonly startLine: number; readonly endLine: number; readonly title: string }>;
  /** Lines that only work inside Jupyter and are kept as comments. */
  readonly magics: number;
  readonly language: string;
}

export function parseNotebook(json: string): { cells: NotebookCell[]; language: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('This notebook is not valid JSON.');
  }
  const nb = data as { cells?: unknown; worksheets?: Array<{ cells?: unknown }>; metadata?: { language_info?: { name?: unknown }; kernelspec?: { language?: unknown } } };
  const raw = Array.isArray(nb?.cells) ? nb.cells : Array.isArray(nb?.worksheets?.[0]?.cells) ? (nb.worksheets[0]!.cells as unknown[]) : null;
  if (!raw) throw new Error('This file has no notebook cells.');
  const textOf = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('') : typeof v === 'string' ? v : '');
  const cells = raw.map((c, i): NotebookCell => {
    const cell = (c ?? {}) as { cell_type?: unknown; source?: unknown; input?: unknown; outputs?: unknown };
    const kind = cell.cell_type === 'code' ? 'code' : cell.cell_type === 'markdown' || cell.cell_type === 'heading' ? 'markdown' : 'raw';
    return { number: i + 1, kind, text: textOf(cell.source ?? cell.input).replace(/\r\n?/g, '\n'), outputs: Array.isArray(cell.outputs) ? cell.outputs.length : 0 };
  });
  const language = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language;
  return { cells, language: typeof language === 'string' ? language.toLowerCase() : 'python' };
}

export function notebookToPython(json: string): NotebookText {
  const { cells, language } = parseNotebook(json);
  const lines: string[] = [];
  const places: Array<NotebookText['cells'][number]> = [];
  let magics = 0;
  for (const c of cells) {
    const startLine = lines.length + 1;
    const body = c.text.split('\n');
    const title = c.kind === 'markdown' ? (body.find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? '') : (body.find((l) => l.trim()) ?? '');
    lines.push(`# %% cell ${c.number} (${c.kind})`);
    if (c.kind === 'code' && language === 'python') {
      const cellMagic = /^\s*%%/.test(body.find((l) => l.trim()) ?? '');
      for (const l of body) {
        // `%magic`, `!command` and `name?` are Jupyter, not Python: kept visible, as comments of the same line.
        if (cellMagic || /^\s*[%!]/.test(l) || /^\s*[\w.]+\?{1,2}\s*$/.test(l)) {
          if (l.trim()) magics++;
          const indent = /^\s*/.exec(l)![0];
          lines.push(cellMagic ? `# ${l}` : l.trim() ? `${indent}pass  # ${l.trim()}` : l);
        } else lines.push(l);
      }
    } else for (const l of body) lines.push(l ? `# ${l}` : '#');
    lines.push('');
    places.push({ number: c.number, kind: c.kind, startLine, endLine: lines.length - 1, title: title.slice(0, 80) });
  }
  return { source: lines.join('\n'), cells: places, magics, language };
}
