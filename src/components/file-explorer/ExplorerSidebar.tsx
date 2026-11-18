import type { OutlineSymbol } from '../../core/parser/outline';
import type { RepositoryFile } from '../../core/repository/types';
import type { LineRange } from '../../core/source-mapping/types';
import { OutlineList } from '../code-editor/OutlineList';
import { Panel } from '../layout/Panel';
import { FileExplorer } from './FileExplorer';
import './ExplorerSidebar.css';

export interface ExplorerSidebarProps {
  readonly projectName: string;
  readonly files: readonly RepositoryFile[];
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
  /** Outline of the selected file; null when the file type has no outline. */
  readonly outline: readonly OutlineSymbol[] | null;
  readonly activeLines: LineRange | null;
  readonly onSelectSymbol: (symbol: OutlineSymbol) => void;
}

export function ExplorerSidebar(props: ExplorerSidebarProps) {
  return (
    <Panel title="Files" icon="folder" accentVar="--hue-sun" subtitle={props.projectName} className="explorer-sidebar">
      <div className="explorer-sidebar__files">
        <FileExplorer files={props.files} selectedPath={props.selectedPath} onSelect={props.onSelectFile} />
      </div>
      {props.outline ? (
        <section className="explorer-sidebar__outline" aria-label="Outline">
          <h3 className="explorer-sidebar__heading">Outline</h3>
          <div className="explorer-sidebar__outline-list">
            <OutlineList symbols={props.outline} activeLines={props.activeLines} onSelect={props.onSelectSymbol} />
          </div>
        </section>
      ) : null}
    </Panel>
  );
}
