import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseCsvRows } from '../../core/simulation/csv';
import { fromJson, fromToml, fromYaml, type Structured } from '../../core/structured/structured';
import { imageSize, isImage, MAX_PIXELS, MIME, mismatch, sniff, type Content } from '../../core/repository/sniff';
import type { FileCategory, ProjectSource, RepositoryFile } from '../../core/repository/types';
import { formatBytes } from '../file-explorer/FileExplorer';
import './FilePreview.css';

/** Categories that have a view besides their source text. */
export function previewKind(category: FileCategory): 'image' | 'svg' | 'table' | 'tree' | 'markdown' | null {
  switch (category) {
    case 'image':
      return 'image';
    case 'svg':
      return 'svg';
    case 'csv':
      return 'table';
    case 'json':
    case 'yaml':
    case 'toml':
      return 'tree';
    case 'markdown':
      return 'markdown';
    default:
      return null;
  }
}

export function FilePreview({ project, file }: { project: ProjectSource; file: RepositoryFile }) {
  const kind = previewKind(file.category);
  if (kind === 'image' || kind === 'svg') return <ImagePreview project={project} file={file} />;
  return <TextPreview project={project} file={file} />;
}

// ---- Images ------------------------------------------------------------------------

type ImageState = { status: 'loading' } | { status: 'problem'; message: string } | { status: 'ready'; url: string; content: Content | 'svg'; width: number | null; height: number | null };

/**
 * Images are shown only when their bytes really are an image. SVG is drawn through
 * an <img>, where the browser runs no scripts and loads nothing from outside.
 */
function ImagePreview({ project, file }: { project: ProjectSource; file: RepositoryFile }) {
  const [state, setState] = useState<ImageState>({ status: 'loading' });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setState({ status: 'loading' });
    setNatural(null);
    project
      .readBlob(file.path)
      .then(async (blob) => {
        const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
        const content = sniff(head);
        if (cancelled) return;
        if (file.category === 'svg') {
          if (content !== 'text' || !/<svg[\s>]/i.test(new TextDecoder().decode(head.subarray(0, 65536)))) {
            setState({ status: 'problem', message: 'The name says SVG, but the content is not an SVG image.' });
            return;
          }
          url = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }));
          setState({ status: 'ready', url, content: 'svg', width: null, height: null });
          return;
        }
        const wrong = mismatch('image', content);
        if (wrong || !isImage(content)) {
          setState({ status: 'problem', message: wrong ?? 'This image cannot be shown.' });
          return;
        }
        const size = imageSize(head, content);
        if (size && size.width * size.height > MAX_PIXELS) {
          setState({ status: 'problem', message: `This image is ${size.width} × ${size.height} pixels, which is too large to show safely.` });
          return;
        }
        // The type comes from the content, never from the name.
        url = URL.createObjectURL(new Blob([blob], { type: MIME[content]! }));
        setState({ status: 'ready', url, content, width: size?.width ?? null, height: size?.height ?? null });
      })
      .catch((err: unknown) => !cancelled && setState({ status: 'problem', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [project, file]);

  if (state.status === 'loading') return <p className="preview__message">Loading…</p>;
  if (state.status === 'problem') return <p className="preview__message is-problem">{state.message}</p>;
  const width = state.width ?? natural?.width;
  const height = state.height ?? natural?.height;
  return (
    <div className="preview preview--image">
      <img
        src={state.url}
        alt={`Content of ${file.name}`}
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onError={() => setState({ status: 'problem', message: 'The browser could not draw this image. It may be damaged.' })}
      />
      <p className="preview__facts">
        {state.content.toUpperCase()}
        {width && height ? ` · ${width} × ${height} px` : ''} · {formatBytes(file.size)}
      </p>
    </div>
  );
}

// ---- Text formats ---------------------------------------------------------------------

function TextPreview({ project, file }: { project: ProjectSource; file: RepositoryFile }) {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setProblem(null);
    project.readText(file.path).then(
      (t) => !cancelled && setText(t.replace(/^﻿/, '').replace(/\r\n?/g, '\n')),
      (err: unknown) => !cancelled && setProblem(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [project, file]);
  if (problem) return <p className="preview__message is-problem">{problem}</p>;
  if (text === null) return <p className="preview__message">Loading…</p>;
  switch (previewKind(file.category)) {
    case 'table':
      return <CsvPreview text={text} name={file.name} />;
    case 'markdown':
      return <Markdown text={text} />;
    default:
      return <TreePreview text={text} file={file} />;
  }
}

const SHOWN_ROWS = 200;

export function CsvPreview({ text, name }: { text: string; name: string }) {
  const { rows, separator } = useMemo(() => {
    const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    const counts = [',', ';', '\t'].map((s) => [s, first.split(s).length - 1] as const).sort((a, b) => b[1] - a[1]);
    const separator = counts[0]![1] > 0 ? counts[0]![0] : ',';
    return { rows: separator === ',' ? parseCsvRows(text) : text.split('\n').filter((l) => l !== '').map((l) => l.split(separator).map((c) => c.replace(/^"(.*)"$/, '$1'))), separator };
  }, [text]);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const numeric = header.map((_, c) => body.length > 0 && body.slice(0, 200).every((r) => (r[c] ?? '') === '' || Number.isFinite(Number(r[c]))));
  return (
    <div className="preview">
      <p className="preview__facts">
        {name} · {body.length} rows · {header.length} columns{separator === ',' ? '' : ` · separated by ${separator === '\t' ? 'tabs' : `“${separator}”`}`}
        {body.length > SHOWN_ROWS ? ` · the first ${SHOWN_ROWS} rows are shown` : ''}
      </p>
      <div className="preview__scroll">
        <table className="preview__table">
          <thead>
            <tr>
              <th aria-label="row" />
              {header.map((h, i) => (
                <th key={i}>
                  {h} <small>{numeric[i] ? 'number' : 'text'}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, SHOWN_ROWS).map((r, i) => (
              <tr key={i}>
                <th>{i}</th>
                {header.map((_, c) => (
                  <td key={c} className={numeric[c] ? 'is-number' : undefined}>
                    {r[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TreePreview({ text, file }: { text: string; file: RepositoryFile }) {
  const [tree, setTree] = useState<Structured | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setProblem(null);
    const read = async () => (file.category === 'json' ? fromJson(text) : file.category === 'toml' ? fromToml(text) : fromYaml(text));
    read().then(
      (t) => !cancelled && setTree(t),
      (err: unknown) => !cancelled && setProblem(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [text, file]);
  if (problem) return <p className="preview__message is-problem">Not shown as a tree: {problem} The source is unchanged.</p>;
  if (!tree) return <p className="preview__message">Loading…</p>;
  return (
    <div className="preview preview--tree">
      <TreeNode name={file.name} value={tree} depth={0} />
    </div>
  );
}

function TreeNode({ name, value, depth }: { name: string; value: Structured; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(100);
  if (value.kind === 'scalar') {
    return (
      <div className="preview__leaf">
        <span>{name}</span> <b className={`is-${value.type.replace(/\W/g, '')}`}>{value.text.length > 400 ? `${value.text.slice(0, 399)}…` : value.text || '—'}</b>
      </div>
    );
  }
  const children: ReadonlyArray<readonly [string, Structured]> = value.kind === 'object' ? value.entries : value.items.map((v, i) => [String(i), v] as const);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="preview__branch">
      <summary>
        {name} <small>{value.kind === 'object' ? `${children.length} entries` : `list of ${children.length}`}</small>
      </summary>
      {open ? (
        <div className="preview__children">
          {children.slice(0, shown).map(([k, v], i) => (
            <TreeNode key={i} name={k} value={v} depth={depth + 1} />
          ))}
          {children.length > shown ? (
            <button type="button" className="btn btn--ghost" onClick={() => setShown(shown + 500)}>
              show more ({children.length - shown})
            </button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/**
 * Markdown as plain React elements. HTML inside it stays visible text, links are
 * shown but do nothing, and images are not loaded.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return <div className="preview preview--markdown">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]+)\]\(([^)]*)\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<b key={key}>{m[2] ?? m[3]}</b>);
    else if (m[4] !== undefined) out.push(<i key={key}>{m[4]}</i>);
    else if (m[6] !== undefined) out.push(<span key={key} className="preview__image-note">🖼 {m[5] || m[6]}</span>);
    else out.push(<span key={key} className="preview__link" title={m[8]}>{m[7]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function markdownBlocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length && out.length < 5000) {
    const l = lines[i]!;
    const fence = /^\s*(```|~~~)/.exec(l);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) code.push(lines[i]!);
      i++;
      out.push(<pre key={i}>{code.join('\n')}</pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(l);
    if (heading) {
      const level = heading[1]!.length;
      const content = inline(heading[2]!.replace(/\s+#+\s*$/, ''));
      out.push(level === 1 ? <h3 key={i}>{content}</h3> : level === 2 ? <h4 key={i}>{content}</h4> : <h5 key={i}>{content}</h5>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push(<hr key={i} />);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      const rows: string[][] = [];
      const key = i;
      for (i += 2; i < lines.length && /\|/.test(lines[i]!) && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      out.push(
        <table key={key} className="preview__table">
          <thead>
            <tr>
              {head.map((c, k) => (
                <th key={k}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k}>
                {head.map((_, c) => (
                  <td key={c}>{inline(r[c] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const items: ReactNode[] = [];
      const ordered = /^\s*\d/.test(l);
      const key = i;
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i]!); i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        items.push(
          <li key={i} style={{ marginLeft: `${Math.min(6, Math.floor((m?.[1]?.length ?? 0) / 2))}em` }} className={m ? undefined : 'is-continued'}>
            {inline(m ? m[3]! : lines[i]!.trim())}
          </li>,
        );
      }
      out.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const quote: string[] = [];
      const key = i;
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key}>{inline(quote.join(' '))}</blockquote>);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    const key = i;
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!); i++) para.push(lines[i]!.trim());
    out.push(<p key={key}>{inline(para.join(' '))}</p>);
  }
  return out;
}
