import { CATEGORY_INFO, isTextCategory, viewerLanguageFor } from '../../core/repository/fileTypes';
import type { RepositoryFile } from '../../core/repository/types';
import type { LineRange } from '../../core/source-mapping/types';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';
import { Panel } from '../layout/Panel';
import { CodeViewer } from './CodeViewer';
import './CodePanel.css';

export type FileContentState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly text: string }
  | { readonly status: 'error'; readonly message: string };

export interface CodePanelProps {
  readonly file: RepositoryFile | null;
  readonly content: FileContentState;
  readonly highlight: LineRange | null;
  readonly onLineClick: (line: number) => void;
  readonly onClearHighlight: () => void;
}

/** Original-source panel: path breadcrumb, viewer, and honest states for non-text files. */
export function CodePanel({ file, content, highlight, onLineClick, onClearHighlight }: CodePanelProps) {
  return (
    <Panel
      title="Source"
      icon="code"
      accentVar="--lab-variable"
      subtitle={file ? <Breadcrumb path={file.path} /> : undefined}
      actions={
        highlight ? (
          <button type="button" className="chip chip--button" onClick={onClearHighlight} title="Clear highlight">
            {highlight.startLine === highlight.endLine ? `L${highlight.startLine}` : `L${highlight.startLine}–${highlight.endLine}`}
            <Icon name="close" className="chip__icon" />
          </button>
        ) : null
      }
      className="code-panel"
    >
      <CodePanelBody file={file} content={content} highlight={highlight} onLineClick={onLineClick} />
    </Panel>
  );
}

function CodePanelBody({ file, content, highlight, onLineClick }: Omit<CodePanelProps, 'onClearHighlight'>) {
  if (!file) {
    // A deep link can name a path the project does not contain; say so instead of pretending nothing was asked for.
    if (content.status === 'error') return <PanelMessage title="File not found" body={content.message} tone="error" />;
    return <PanelMessage title="No file selected" body="Choose a file in the explorer to view its original source." />;
  }

  if (!isTextCategory(file.category)) {
    const info = CATEGORY_INFO[file.category];
    return (
      <PanelMessage
        title={file.category === 'image' ? 'Image preview not available yet' : 'Unsupported file type'}
        body={`${file.name} · ${info.label} · ${formatBytes(file.size)}. This file is kept unchanged in the project; previews for more file types arrive with ZIP import (Phase 4).`}
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
          language={viewerLanguageFor(file.path, file.category)}
          highlight={highlight}
          onLineClick={onLineClick}
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
