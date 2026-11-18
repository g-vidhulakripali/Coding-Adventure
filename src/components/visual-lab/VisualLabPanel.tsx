import { Panel } from '../layout/Panel';
import { VisualVocabulary } from './VisualVocabulary';
import './VisualLabPanel.css';

export interface VisualLabPanelProps {
  /** Path of the file open in the code panel, if any. */
  readonly filePath: string | null;
}

/**
 * Visual laboratory panel.
 *
 * Phase 1: an honest empty state plus the visual vocabulary the laboratory will
 * use. Nothing here is derived from the open file — the operation engine,
 * playback controls and simulations are Phase 2 work.
 */
export function VisualLabPanel({ filePath }: VisualLabPanelProps) {
  return (
    <Panel title="Visual Lab" icon="flask" accentVar="--lab-function" subtitle={filePath ?? undefined}>
      <div className="lab-empty">
        <div className="lab-empty__intro">
          <h3>No operations to explore yet</h3>
          <p>
            The step-by-step laboratory arrives in the next phase. Until then, nothing in this panel describes the open file.
          </p>
        </div>
        <VisualVocabulary />
      </div>
    </Panel>
  );
}
