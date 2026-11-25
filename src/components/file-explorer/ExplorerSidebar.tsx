import type { OutlineSymbol } from '../../core/parser/outline';
import type { LeftOut } from '../../core/repository/types';
import type { LineRange } from '../../core/source-mapping/types';
import { OutlineList } from '../code-editor/OutlineList';
import { Panel } from '../layout/Panel';
import { useState } from 'react';
import type { ProjectAnalysis } from '../../app/useProjectAnalysis';
import type { ProjectSource } from '../../core/repository/types';
import { FileExplorer } from './FileExplorer';
import { AssetsPanel, LibrariesPanel, StatusPanel, useAssets } from './ProjectPanels';
import './ExplorerSidebar.css';

export interface ExplorerSidebarProps {
  readonly project: ProjectSource;
  readonly analysis: ProjectAnalysis;
  readonly onGo: (path: string, line: number) => void;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
  /** Outline of the selected file; null when the file type has no outline. */
  readonly outline: readonly OutlineSymbol[] | null;
  readonly activeLines: LineRange | null;
  readonly onSelectSymbol: (symbol: OutlineSymbol) => void;
  /** What the import did not keep. */
  readonly leftOut?: LeftOut | null;
}

type SideTab = 'files' | 'libraries' | 'assets' | 'status';

export function ExplorerSidebar(props: ExplorerSidebarProps) {
  const [tab, setTab] = useState<SideTab>('files');
  const { project, analysis } = props;
  const assets = useAssets(project, analysis, tab === 'assets');
  const s = analysis.snapshot;
  const busy = s !== null && s.state === 'running' && s.remaining > 0;
  return (
    <Panel title="Files" icon="folder" accentVar="--hue-sun" subtitle={project.name} className="explorer-sidebar">
      <div className="side-tabs" role="tablist" aria-label="Project" data-preparation={s?.state ?? 'reading'}>
        {(['files', 'libraries', 'assets', 'status'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'status' && busy ? `${s.total - s.remaining}/${s.total}` : t === 'status' && (s?.failed ?? 0) > 0 ? `status ✗${s!.failed}` : t}
          </button>
        ))}
      </div>
      <div className="explorer-sidebar__files" role="tabpanel">
        {tab === 'files' ? (
          <FileExplorer files={project.files} selectedPath={props.selectedPath} onSelect={props.onSelectFile} statuses={analysis.statuses} />
        ) : tab === 'libraries' ? (
          <LibrariesPanel project={project} analysis={analysis} onGo={props.onGo} />
        ) : tab === 'assets' ? (
          <AssetsPanel report={assets} onGo={props.onGo} onOpen={props.onSelectFile} />
        ) : (
          <StatusPanel analysis={analysis} onOpen={props.onSelectFile} />
        )}
      </div>
      {tab === 'files' ? <LeftOutNote leftOut={props.leftOut ?? null} /> : null}
      {props.outline && tab === 'files' ? (
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
function LeftOutNote({ leftOut }: { leftOut: LeftOut | null }) {
  const count = (leftOut?.folders.length ?? 0) + (leftOut?.refused.length ?? 0);
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
      </ul>
    </details>
  );
}
