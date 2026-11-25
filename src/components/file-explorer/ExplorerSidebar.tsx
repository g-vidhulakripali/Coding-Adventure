import type { OutlineSymbol } from '../../core/parser/outline';
import type { LeftOut, RepositoryFile } from '../../core/repository/types';
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
  /** What the import did not keep. */
  readonly leftOut?: LeftOut | null;
  /** Files kept in the project but too large (or not text) for the analysis. */
  readonly notAnalysed?: readonly string[];
}

export function ExplorerSidebar(props: ExplorerSidebarProps) {
  return (
    <Panel title="Files" icon="folder" accentVar="--hue-sun" subtitle={props.projectName} className="explorer-sidebar">
      <div className="explorer-sidebar__files">
        <FileExplorer files={props.files} selectedPath={props.selectedPath} onSelect={props.onSelectFile} />
      </div>
      <LeftOutNote leftOut={props.leftOut ?? null} notAnalysed={props.notAnalysed ?? []} />
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

/** Says plainly what is not in the list above, and why. */
function LeftOutNote({ leftOut, notAnalysed }: { leftOut: LeftOut | null; notAnalysed: readonly string[] }) {
  const count = (leftOut?.folders.length ?? 0) + (leftOut?.refused.length ?? 0) + notAnalysed.length;
  if (count === 0) return null;
  return (
    <details className="left-out">
      <summary>{count} left out</summary>
      <ul>
        {leftOut?.folders.map((f) => (
          <li key={f.path}>
            <b>{f.path}/</b> {f.files > 0 ? `${f.files} files: ` : ''}tools, caches or history
          </li>
        ))}
        {leftOut?.refused.slice(0, 200).map((r, i) => (
          <li key={i}>
            <b>{r.path}</b> {r.reason}
          </li>
        ))}
        {notAnalysed.map((p) => (
          <li key={p}>
            <b>{p}</b> kept, but not analysed (too large, or not text)
          </li>
        ))}
      </ul>
    </details>
  );
}
