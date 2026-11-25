import type { CallIndex, CallSite, Definition } from '../analysis/python/callIndex';

/**
 * Layered layout for the call map.
 *
 * Nodes are definitions (module scopes that make calls, functions, methods,
 * classes). Edges group every call site from one caller to one internal
 * target. Columns follow call depth from entry points (nodes nobody calls),
 * so reading left → right follows "calls". Optional external nodes (built-ins,
 * libraries, unresolved calls) attach to the right of their caller.
 */

export interface MapNode {
  readonly id: string;
  readonly kind: Definition['kind'] | 'builtin' | 'library' | 'unresolved';
  readonly label: string;
  readonly sublabel: string;
  readonly path: string | null;
  readonly definition: Definition | null;
  readonly x: number;
  readonly y: number;
}

export interface MapEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly sites: readonly CallSite[];
  readonly evidence: 'static' | 'inferred' | 'external' | 'unresolved';
}

export interface CallMapLayout {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly width: number;
  readonly height: number;
}

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 46;
const COL_GAP = 90;
const ROW_GAP = 22;
const PAD = 24;

export function layoutCallMap(index: CallIndex, options: { showExternal: boolean }): CallMapLayout {
  const defs = new Map(index.definitions.map((d) => [d.id, d]));
  const internalEdges = new Map<string, { from: string; to: string; sites: CallSite[]; evidence: 'static' | 'inferred' }>();
  const externalEdges = new Map<string, { from: string; to: string; sites: CallSite[]; evidence: 'external' | 'unresolved'; node: Omit<MapNode, 'x' | 'y'> }>();

  for (const call of index.calls) {
    const t = call.target;
    if (t.kind === 'internal') {
      const key = `${call.callerId}→${t.id}`;
      const edge = internalEdges.get(key) ?? { from: call.callerId, to: t.id, sites: [], evidence: t.evidence };
      edge.sites.push(call);
      if (t.evidence === 'inferred') edge.evidence = 'inferred';
      internalEdges.set(key, edge);
    } else if (options.showExternal) {
      const targetId =
        t.kind === 'builtin' ? `builtin:${t.name}` : t.kind === 'library' ? `library:${t.module}.${t.name}` : `unresolved:${call.callerId}:${call.callee}`;
      const key = `${call.callerId}→${targetId}`;
      const node: Omit<MapNode, 'x' | 'y'> =
        t.kind === 'builtin'
          ? { id: targetId, kind: 'builtin', label: `${t.name}()`, sublabel: 'Python built-in', path: null, definition: null }
          : t.kind === 'library'
            ? { id: targetId, kind: 'library', label: `${t.name}()`, sublabel: t.module, path: null, definition: null }
            : { id: targetId, kind: 'unresolved', label: `${call.callee}()`, sublabel: 'unresolved', path: null, definition: null };
      const edge = externalEdges.get(key) ?? { from: call.callerId, to: targetId, sites: [], evidence: t.kind === 'unresolved' ? 'unresolved' : 'external', node };
      edge.sites.push(call);
      externalEdges.set(key, edge);
    }
  }

  // Which definitions to show: every function/method/class, plus module scopes that make calls.
  const callers = new Set([...internalEdges.values(), ...externalEdges.values()].map((e) => e.from));
  const shown = index.definitions.filter((d) => d.kind !== 'module' || callers.has(d.id));
  const shownIds = new Set(shown.map((d) => d.id));

  // Longest-path layering over internal edges (back edges in cycles are ignored).
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const e of internalEdges.values()) {
    if (!shownIds.has(e.from) || !shownIds.has(e.to) || e.from === e.to) continue;
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to]);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string, d: number) => {
    if (visiting.has(id)) return; // cycle
    if ((depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next, d + 1);
    visiting.delete(id);
  };
  const roots = shown.filter((d) => !incoming.has(d.id));
  // Module scopes first so scripts sit on the left.
  roots.sort((a, b) => (a.kind === 'module' ? -1 : 0) - (b.kind === 'module' ? -1 : 0));
  for (const r of roots) visit(r.id, 0);
  for (const d of shown) if (!depth.has(d.id)) visit(d.id, 0);

  const columns: string[][] = [];
  for (const d of shown) {
    const col = depth.get(d.id) ?? 0;
    (columns[col] ??= []).push(d.id);
  }
  // Sort within a column by file, then by position in the file.
  for (const col of columns) {
    col.sort((a, b) => {
      const da = defs.get(a)!;
      const db = defs.get(b)!;
      return da.path === db.path ? da.span.startLine - db.span.startLine : da.path.localeCompare(db.path);
    });
  }

  const nodes: MapNode[] = [];
  const position = new Map<string, { x: number; y: number }>();
  columns.forEach((col, ci) => {
    col.forEach((id, ri) => {
      const d = defs.get(id)!;
      const x = PAD + ci * (NODE_WIDTH + COL_GAP);
      const y = PAD + ri * (NODE_HEIGHT + ROW_GAP);
      position.set(id, { x, y });
      nodes.push({
        id,
        kind: d.kind,
        label: d.kind === 'module' ? d.name : d.kind === 'class' ? d.qualname : `${d.qualname}()`,
        sublabel: d.kind === 'module' ? `${d.path} · module code` : `${d.path}:${d.span.startLine}`,
        path: d.path,
        definition: d,
        x,
        y,
      });
    });
  });

  // External nodes: a column to the right of each caller, stacked per caller.
  const externalColumnX = PAD + columns.length * (NODE_WIDTH + COL_GAP);
  const externalRow = new Map<string, number>();
  let maxY = Math.max(0, ...nodes.map((n) => n.y));
  const externalNodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  for (const e of internalEdges.values()) {
    if (shownIds.has(e.from) && shownIds.has(e.to)) edges.push({ id: `${e.from}→${e.to}`, from: e.from, to: e.to, sites: e.sites, evidence: e.evidence });
  }
  let row = 0;
  for (const e of externalEdges.values()) {
    if (!shownIds.has(e.from)) continue;
    if (!externalNodes.has(e.to)) {
      const y = PAD + row++ * (NODE_HEIGHT * 0.8 + ROW_GAP * 0.6);
      externalRow.set(e.to, y);
      externalNodes.set(e.to, { ...e.node, x: externalColumnX, y });
      maxY = Math.max(maxY, y);
    }
    edges.push({ id: `${e.from}→${e.to}`, from: e.from, to: e.to, sites: e.sites, evidence: e.evidence });
  }
  nodes.push(...externalNodes.values());

  const maxX = Math.max(0, ...nodes.map((n) => n.x));
  return { nodes, edges, width: maxX + NODE_WIDTH + PAD, height: maxY + NODE_HEIGHT + PAD };
}
