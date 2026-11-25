import { CATEGORY_INFO, isTextCategory, viewerLanguageFor } from '../../core/repository/fileTypes';
import { useState } from 'react';
import type { NotebookText } from '../../core/repository/notebook';
import type { ProjectSource, RepositoryFile } from '../../core/repository/types';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';
import { Panel } from '../layout/Panel';
import { CodeViewer } from './CodeViewer';
import type { CodeLink, ViewerHighlight } from './codemirrorSetup';
import { FilePreview, previewKind } from './FilePreview';
import './CodePanel.css';

export type FileContentState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly text: string }
  | { readonly status: 'error'; readonly message: string };

export interface CodePanelProps {
  readonly file: RepositoryFile | null;
  readonly content: FileContentState;
  readonly highlight: ViewerHighlight | null;
  readonly onLineClick: (line: number) => void;
  readonly onClearHighlight: () => void;
  readonly project?: ProjectSource;
  readonly links?: readonly CodeLink[];
  readonly onFollow?: (line: number, column: number) => void;
  /** Set for notebooks: their cells as Python, and the way to see the raw file. */
  readonly notebook?: NotebookText | null;
}

/** Original-source panel: path breadcrumb, viewer, and honest states for non-text files. */
export function CodePanel({ file, content, highlight, onLineClick, onClearHighlight, project, links, onFollow, notebook }: CodePanelProps) {
  const kind = file ? previewKind(file.category) : null;
  // Per file: what the user chose, else the view that fits the type. Asking for a line shows the source.
  const [choice, setChoice] = useState<{ path: string; view: 'preview' | 'source' } | null>(null);
  const view = choice && choice.path === file?.path ? choice.view : kind && !highlight ? 'preview' : 'source';
  const isNotebook = file?.category === 'notebook' && !!notebook;
  return (
    <Panel
      title="Source"
      icon="code"
      accentVar="--lab-variable"
      subtitle={file ? <Breadcrumb path={file.path} /> : undefined}
      actions={
        <>
        {file && project && kind && file.category !== 'image' ? (
          <div className="seg" role="radiogroup" aria-label="How to show this file">
            {(['preview', 'source'] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setChoice({ path: file.path, view: v })}>
                {v}
              </button>
            ))}
          </div>
        ) : null}
        {isNotebook ? (
          <select className="notebook-cells" value="" onChange={(e) => onLineClick(Number(e.target.value))} aria-label="Go to cell">
            <option value="" disabled>
              {notebook.cells.length} cells
            </option>
            {notebook.cells.map((c) => (
              <option key={c.number} value={c.startLine}>
                {c.number} {c.kind === 'code' ? '▸' : '¶'} {c.title || '(empty)'}
              </option>
            ))}
          </select>
        ) : null}
        {highlight ? (
          <button type="button" className="chip chip--button" onClick={onClearHighlight} title="Clear highlight">
            {highlight.startLine === highlight.endLine ? `L${highlight.startLine}` : `L${highlight.startLine}–${highlight.endLine}`}
            <Icon name="close" className="chip__icon" />
          </button>
        ) : null}
        </>
      }
      className="code-panel"
    >
      {file && project && kind && view === 'preview' ? (
        <FilePreview project={project} file={file} />
      ) : (
        <CodePanelBody file={file} content={content} highlight={highlight} onLineClick={onLineClick} links={links} onFollow={onFollow} isNotebook={isNotebook} />
      )}
    </Panel>
  );
}

function CodePanelBody({ file, content, highlight, onLineClick, links, onFollow, isNotebook }: Omit<CodePanelProps, 'onClearHighlight' | 'project' | 'notebook'> & { isNotebook: boolean }) {
  if (!file) {
    // A deep link can name a path the project does not contain; say so instead of pretending nothing was asked for.
    if (content.status === 'error') return <PanelMessage title="File not found" body={content.message} tone="error" />;
    return <PanelMessage title="No file selected" body="Choose a file in the explorer to view its original source." />;
  }

  if (!isTextCategory(file.category)) {
    const info = CATEGORY_INFO[file.category];
    return (
      <PanelMessage
        title={file.category === 'image' ? 'Image' : 'No viewer for this file type'}
        body={`${file.name} · ${info.label} · ${formatBytes(file.size)}. ${file.note ?? 'This file is kept unchanged in the project. A preview for this file type is not available yet.'}`}
      />
    );
  }

  switch (content.status) {
    case 'idle':
    case 'loading':
      return <PanelMessage title="Loading…" body={file.path} />;
    case 'error':
      return <PanelMessage title="Could not open this file" body={content.message} tone="error" />;
    case 'ready':
      return (
        <CodeViewer
          path={file.path}
          content={content.text}
          language={isNotebook ? 'python' : viewerLanguageFor(file.path, file.category)}
          highlight={highlight}
          onLineClick={onLineClick}
          links={links}
          onFollow={onFollow}
        />
      );
  }
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split('/');
  return (
    <span className="breadcrumb" title={path}>
      {parts.map((part, i) => (
        <span key={i} className={i === parts.length - 1 ? 'breadcrumb__leaf' : 'breadcrumb__part'}>
          {part}
          {i < parts.length - 1 ? <span className="breadcrumb__sep">/</span> : null}
        </span>
      ))}
    </span>
  );
}

function PanelMessage({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  return (
    <div className={tone === 'error' ? 'panel-message panel-message--error' : 'panel-message'} role={tone === 'error' ? 'alert' : undefined}>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
