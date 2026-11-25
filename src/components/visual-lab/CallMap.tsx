import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { CallIndex, CallSite } from '../../core/analysis/python/callIndex';
import type { LineRange } from '../../core/source-mapping/types';
import { layoutCallMap, NODE_HEIGHT, NODE_WIDTH, type MapEdge, type MapNode } from '../../core/visualisation/callMapLayout';
import { EvidenceBadge } from '../explanation/EvidenceBadge';
import './CallMap.css';

export interface CallMapProps {
  readonly index: CallIndex;
  readonly currentFile: string | null;
  readonly onNavigate: (path: string, lines: LineRange) => void;
}

const FILE_COLORS = ['--lab-variable', '--lab-function', '--lab-loop', '--lab-decision', '--lab-collection', '--lab-return', '--lab-value'];

/**
 * Static call map: which functions call which, and from where.
 * Every edge lists its exact call sites; clicking navigates to the source.
 */
export function CallMap({ index, currentFile, onNavigate }: CallMapProps) {
  const [showExternal, setShowExternal] = useState(false);
  const layout = useMemo(() => layoutCallMap(index, { showExternal }), [index, showExternal]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const fileColor = useMemo(() => {
    const files = [...new Set(index.definitions.map((d) => d.path))].sort();
    return (path: string | null) => (path ? `var(${FILE_COLORS[files.indexOf(path) % FILE_COLORS.length]})` : 'var(--color-text-faint)');
  }, [index]);

  // Default selection: the first definition in the open file.
  useEffect(() => {
    if (selected && layout.nodes.some((n) => n.id === selected)) return;
    const inFile = layout.nodes.find((n) => n.path === currentFile && n.kind !== 'module') ?? layout.nodes.find((n) => n.path === currentFile);
    setSelected(inFile?.id ?? layout.nodes[0]?.id ?? null);
  }, [layout, currentFile, selected]);

  const fit = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    const k = Math.min(1.2, Math.max(0.3, Math.min(width / layout.width, height / layout.height)));
    setView({ k, x: (width - layout.width * k) / 2, y: Math.max(8, (height - layout.height * k) / 2) });
  };
  useEffect(fit, [layout]);

  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const related = useMemo(() => {
    const set = new Set<string>();
    if (!selected) return set;
    for (const e of layout.edges) if (e.from === selected || e.to === selected) set.add(e.id);
    return set;
  }, [layout, selected]);

  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
      d.moved = true;
    }
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const incoming = selectedNode ? layout.edges.filter((e) => e.to === selectedNode.id) : [];
  const outgoingAll = selectedNode ? index.calls.filter((c) => c.callerId === selectedNode.id) : [];

  if (layout.nodes.length === 0) {
    return <p className="callmap__empty">No Python functions found in this project.</p>;
  }

  return (
    <div className="callmap">
      <div className="callmap__toolbar">
        <label className="callmap__toggle">
          <input type="checkbox" checked={showExternal} onChange={(e) => setShowExternal(e.target.checked)} />
          show built-in, library &amp; unresolved calls
        </label>
        <span className="callmap__legend">
          <i className="is-static" /> static <i className="is-inferred" /> inferred <i className="is-external" /> external
        </span>
        <button type="button" className="btn btn--ghost callmap__fit" onClick={fit}>
          fit
        </button>
      </div>
      <svg
        ref={svgRef}
        className="callmap__canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="group"
        aria-label="Call map: functions and the calls between them"
      >
        <defs>
          {['static', 'inferred', 'external', 'unresolved'].map((k) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" className={`callmap__arrow is-${k}`} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.edges.map((e) => (
            <EdgePath key={e.id} edge={e} from={nodeById.get(e.from)} to={nodeById.get(e.to)} active={related.has(e.id)} dimmed={selected !== null && !related.has(e.id)} />
          ))}
          {layout.nodes.map((n) => (
            <NodeBox
              key={n.id}
              node={n}
              color={fileColor(n.path)}
              selected={n.id === selected}
              dimmed={selected !== null && n.id !== selected && !layout.edges.some((e) => related.has(e.id) && (e.from === n.id || e.to === n.id))}
              onSelect={() => {
                if (!drag.current?.moved) setSelected(n.id);
              }}
            />
          ))}
        </g>
      </svg>

      {selectedNode ? (
        <section className="callmap__details" aria-label={`Details for ${selectedNode.label}`}>
          <header>
            <b>{selectedNode.label}</b>
            {selectedNode.definition ? (
              <button
                type="button"
                className="callmap__link"
                onClick={() => onNavigate(selectedNode.definition!.path, { startLine: selectedNode.definition!.span.startLine, endLine: selectedNode.definition!.span.endLine })}
              >
                {selectedNode.definition.kind === 'module' ? `open ${selectedNode.definition.path}` : `defined at ${selectedNode.definition.path}:${selectedNode.definition.span.startLine}`}
              </button>
            ) : (
              <span className="callmap__muted">{selectedNode.sublabel}</span>
            )}
          </header>
          {selectedNode.definition ? (
            <div className="callmap__columns">
              <div>
                <h4>Called from ({incoming.reduce((n, e) => n + e.sites.length, 0)})</h4>
                {incoming.length === 0 ? (
                  <p className="callmap__muted">No static call sites found{selectedNode.kind === 'module' ? ' (module code runs on import or as a script)' : '. It may be unused, called dynamically, or called from outside this project'}.</p>
                ) : (
                  <ul>
                    {incoming.flatMap((e) =>
                      e.sites.map((site) => (
                        <SiteRow key={site.id} site={site} label={nodeById.get(e.from)?.label ?? e.from} evidence={e.evidence === 'inferred' ? 'inferred' : 'static'} onNavigate={onNavigate} />
                      )),
                    )}
                  </ul>
                )}
              </div>
              <div>
                <h4>Calls ({outgoingAll.length})</h4>
                {outgoingAll.length === 0 ? (
                  <p className="callmap__muted">Makes no calls.</p>
                ) : (
                  <ul>
                    {outgoingAll.map((site) => (
                      <SiteRow key={site.id} site={site} label={describeTarget(site, nodeById)} evidence={site.target.kind === 'internal' ? site.target.evidence : site.target.kind === 'unresolved' ? 'unsupported' : 'verified'} onNavigate={onNavigate} showCallee />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <p className="callmap__muted">
              Called {incoming.reduce((n, e) => n + e.sites.length, 0)} time(s). {selectedNode.kind === 'unresolved' ? 'The target cannot be determined without running the code.' : 'Defined outside this project.'}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function describeTarget(site: CallSite, nodes: Map<string, MapNode>): string {
  const t = site.target;
  switch (t.kind) {
    case 'internal':
      return `→ ${nodes.get(t.id)?.label ?? t.id}`;
    case 'builtin':
      return '→ Python built-in';
    case 'library':
      return `→ library ${t.module}`;
    case 'unresolved':
      return '→ unresolved';
  }
}

function SiteRow({
  site,
  label,
  evidence,
  onNavigate,
  showCallee = false,
}: {
  site: CallSite;
  label: string;
  evidence: 'static' | 'inferred' | 'verified' | 'unsupported';
  onNavigate: (path: string, lines: LineRange) => void;
  showCallee?: boolean;
}) {
  const reason = site.target.kind === 'internal' || site.target.kind === 'unresolved' ? site.target.reason : undefined;
  return (
    <li className="callmap__site">
      <button type="button" className="callmap__link" onClick={() => onNavigate(site.span.path, { startLine: site.span.startLine, endLine: site.span.endLine })} title={reason}>
        {site.span.path}:{site.span.startLine}
      </button>
      {showCallee ? <code>{site.callee}()</code> : null}
      <span className="callmap__muted">{label}</span>
      {evidence === 'verified' ? null : <EvidenceBadge level={evidence} />}
    </li>
  );
}

function NodeBox({ node, color, selected, dimmed, onSelect }: { node: MapNode; color: string; selected: boolean; dimmed: boolean; onSelect: () => void }) {
  const external = node.kind === 'builtin' || node.kind === 'library' || node.kind === 'unresolved';
  const h = external ? NODE_HEIGHT * 0.8 : NODE_HEIGHT;
  return (
    <g
      className={`callmap__node is-${node.kind}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
      transform={`translate(${node.x} ${node.y})`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-label={`${node.label}, ${node.sublabel}`}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{ ['--node-color' as string]: color }}
    >
      <rect width={NODE_WIDTH} height={h} rx={node.kind === 'module' ? 4 : 10} className="callmap__box" />
      <rect width={5} height={h} rx={2} className="callmap__stripe" />
      <text x={14} y={external ? 16 : 19} className="callmap__label">
        {truncate(node.label, 24)}
      </text>
      <text x={14} y={external ? 30 : 35} className="callmap__sublabel">
        {truncate(node.sublabel, 30)}
      </text>
    </g>
  );
}

function EdgePath({ edge, from, to, active, dimmed }: { edge: MapEdge; from: MapNode | undefined; to: MapNode | undefined; active: boolean; dimmed: boolean }) {
  if (!from || !to) return null;
  const toH = to.kind === 'builtin' || to.kind === 'library' || to.kind === 'unresolved' ? NODE_HEIGHT * 0.8 : NODE_HEIGHT;
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  let x2 = to.x;
  const y2 = to.y + toH / 2;
  let d: string;
  if (x2 > x1) {
    const mx = (x1 + x2) / 2;
    d = `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  } else {
    // Same or earlier column (cycles, same-depth calls): loop over the top.
    x2 = to.x + NODE_WIDTH / 2;
    const top = Math.min(from.y, to.y) - 30;
    d = `M${x1} ${y1} C${x1 + 60} ${top} ${x2 + 40} ${top} ${x2} ${to.y}`;
  }
  return (
    <g className={`callmap__edge is-${edge.evidence}${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}`}>
      <path d={d} markerEnd={`url(#arrow-${edge.evidence})`} />
      {edge.sites.length > 1 ? (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} className="callmap__count">
          ×{edge.sites.length}
        </text>
      ) : null}
      <title>
        {edge.sites.length} call{edge.sites.length === 1 ? '' : 's'}: {edge.sites.map((s) => `${s.span.path}:${s.span.startLine}`).join(', ')}
      </title>
    </g>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
