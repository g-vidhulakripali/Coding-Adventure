import type { ReactNode } from 'react';
import { EVIDENCE_INFO, EVIDENCE_ORDER } from '../../core/analysis/evidence';
import { CATEGORY_INFO } from '../../core/repository/fileTypes';
import type { RepositoryFile } from '../../core/repository/types';
import type { FileOutline } from '../../core/parser/outline';
import { flattenOutline } from '../../core/parser/outline';
import { Icon } from '../common/Icon';
import { formatBytes } from '../file-explorer/FileExplorer';
import { Panel } from '../layout/Panel';
import { EvidenceBadge } from './EvidenceBadge';
import './ExplanationPanel.css';

export interface ExplanationPanelProps {
  readonly file: RepositoryFile | null;
  readonly lineCount: number | null;
  readonly outline: FileOutline | null;
  readonly onCollapse?: () => void;
}

/**
 * Explanation & verification panel.
 *
 * Phase 1 shows only facts it can back up: file metadata read from the
 * original repository and the parsed outline. Operation explanations arrive
 * with the visual laboratory (Phase 2) and static analysis (Phase 3).
 */
export function ExplanationPanel({ file, lineCount, outline, onCollapse }: ExplanationPanelProps) {
  const symbols = outline ? flattenOutline(outline.symbols) : [];
  const classes = symbols.filter((s) => s.kind === 'class').length;
  const functions = symbols.length - classes;

  return (
    <Panel
      title="Explain"
      icon="info"
      accentVar="--lab-loop"
      actions={
        onCollapse ? (
          <button type="button" className="btn btn--icon btn--ghost" onClick={onCollapse} aria-label="Collapse explanation panel" title="Collapse">
            <Icon name="chevronRight" />
          </button>
        ) : null
      }
    >
      <div className="explain">
        {file ? (
          <section className="explain__section">
            <h3 className="explain__heading">This file</h3>
            <dl className="explain__facts">
              <Fact label="Path" evidence="verified">
                <code>{file.path}</code>
              </Fact>
              <Fact label="Type" evidence="verified">
                {CATEGORY_INFO[file.category].label}
              </Fact>
              <Fact label="Size" evidence="verified">
                {formatBytes(file.size)}
                {lineCount !== null ? ` · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}` : null}
              </Fact>
              {outline ? (
                <Fact label="Defines" evidence="static">
                  {functions} {functions === 1 ? 'function' : 'functions'}, {classes} {classes === 1 ? 'class' : 'classes'}
                </Fact>
              ) : null}
            </dl>
            {outline && outline.syntaxErrorCount > 0 ? (
              <p className="explain__warning">
                <Icon name="alert" />
                The parser recovered from {outline.syntaxErrorCount} syntax error {outline.syntaxErrorCount === 1 ? 'region' : 'regions'}. The outline may be incomplete.
              </p>
            ) : null}
            {file.category === 'other' ? (
              <p className="explain__warning">
                <Icon name="alert" />
                This file type is not supported yet. It is listed so nothing in the repository is hidden.
              </p>
            ) : null}
          </section>
        ) : (
          <p className="explain__muted">Select a file to see what is known about it.</p>
        )}

        <section className="explain__section">
          <h3 className="explain__heading">Operation explanations</h3>
          <p className="explain__muted">
            Not available yet. Step-by-step explanations of what each operation does, with its inputs and outputs, come with the
            visual laboratory (Phase 2) and Python analysis (Phase 3).
          </p>
        </section>

        <details className="explain__section explain__legend">
          <summary className="explain__heading">How to read the badges</summary>
          <ul>
            {EVIDENCE_ORDER.map((level) => (
              <li key={level}>
                <EvidenceBadge level={level} />
                <span>{EVIDENCE_INFO[level].description}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Panel>
  );
}

function Fact({ label, evidence, children }: { label: string; evidence: 'verified' | 'static'; children: ReactNode }) {
  return (
    <div className="explain__fact">
      <dt>{label}</dt>
      <dd>
        <span className="explain__fact-value">{children}</span>
        <EvidenceBadge level={evidence} />
      </dd>
    </div>
  );
}

/** Slim rail shown when the explanation panel is collapsed. */
export function ExplanationRail({ onExpand }: { onExpand: () => void }) {
  return (
    <button type="button" className="explain-rail" onClick={onExpand} aria-label="Expand explanation panel" title="Expand explanation">
      <Icon name="chevronLeft" />
      <span className="explain-rail__label">Explain</span>
    </button>
  );
}
