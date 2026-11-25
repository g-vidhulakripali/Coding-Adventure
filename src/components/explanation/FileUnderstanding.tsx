import { useMemo } from 'react';
import type { ProjectAnalysis } from '../../app/useProjectAnalysis';
import type { RepositoryFile } from '../../core/repository/types';
import { InlineCode } from '../visual-lab/InlineCode';
import { EvidenceBadge } from './EvidenceBadge';

const COUNT_LABELS = ['functions', 'async functions', 'classes', 'imports', 'calls', 'assignments', 'conditions', 'loops', 'comprehensions', 'exceptions', 'decorators', 'with blocks', 'returns'];

/** What is understood of a file, what is not, who uses the selected definition, and which files are connected. */
export function FileUnderstanding({ file, analysis, line, onGo }: { file: RepositoryFile; analysis: ProjectAnalysis; line: number | null; onGo: (path: string, line: number) => void }) {
  const a = analysis.analyses.get(file.path);
  const status = analysis.statuses.get(file.path);
  const { index } = analysis;
  const definition = useMemo(() => (index && line !== null ? index.definitionAt(file.path, line) : null), [index, file.path, line]);
  const uses = useMemo(() => {
    if (!index || !definition) return [];
    const places = index.usesOf(definition).map((u) => ({ path: u.use.span.path, line: u.use.span.startLine, evidence: 'static' as const }));
    const id = `${definition.path}::${definition.name}`;
    for (const c of index.callIndex.calls) {
      if (c.target.kind === 'internal' && c.target.id === id && !places.some((p) => p.path === c.span.path && p.line === c.span.startLine)) places.push({ path: c.span.path, line: c.span.startLine, evidence: c.target.evidence as 'static' });
    }
    return places.filter((p) => !(p.path === definition.path && p.line === definition.line));
  }, [index, definition]);
  const related = useMemo(() => {
    if (!index) return null;
    const needs = new Map<string, number>();
    for (const u of index.usesIn(file.path)) if (u.target.path !== file.path) needs.set(u.target.path, (needs.get(u.target.path) ?? 0) + 1);
    const usedBy = new Map<string, number>();
    for (const other of index.files.keys()) {
      if (other === file.path) continue;
      const n = index.usesIn(other).filter((u) => u.target.path === file.path).length;
      if (n > 0) usedBy.set(other, n);
    }
    return { needs: [...needs], usedBy: [...usedBy] };
  }, [index, file.path]);

  if (status?.state === 'failed') return <p className="explain__muted">Not analysed: {status.reason}</p>;
  if (!a) return status?.state === 'waiting' || status?.state === 'processing' ? <p className="explain__muted">This file is being prepared…</p> : null;
  const c = a.coverage;
  return (
    <>
      <div className="explain__fact">
        <dt>Read</dt>
        <dd>
          <span className="explain__fact-value">
            {c.understood} of {c.statements} statements
          </span>
          <EvidenceBadge level="static" />
        </dd>
      </div>
      <div className="explain__fact">
        <dt>Checked</dt>
        <dd>
          <span className="explain__fact-value">{a.check === null ? 'not checked by the second parser' : a.check.agree ? 'two parsers agree' : 'the parsers differ'}</span>
          <EvidenceBadge level={a.check?.agree ? 'verified' : 'inferred'} />
        </dd>
      </div>
      <details className="explain__legend">
        <summary className="explain__heading">What is in it</summary>
        <p className="explain__muted">
          {COUNT_LABELS.filter((k) => c.counts[k])
            .map((k) => `${c.counts[k]} ${k}`)
            .join(' · ')}
        </p>
        {a.check && !a.check.agree ? (
          <ul className="explain__places">
            {a.check.differences.map((d, i) => (
              <li key={i}>
                <InlineCode text={d} />
              </li>
            ))}
          </ul>
        ) : null}
      </details>
      {c.gaps.length > 0 ? (
        <details className="explain__legend">
          <summary className="explain__heading">Not understood or not simulated ({c.gaps.length})</summary>
          <ul className="explain__places">
            {c.gaps.map((g, i) => (
              <li key={i}>
                <button type="button" className="explain__link" onClick={() => onGo(file.path, g.line)}>
                  line {g.line}
                </button>{' '}
                <EvidenceBadge level="unsupported" /> <code>{g.code}</code> {g.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {definition ? (
        <details className="explain__legend" open>
          <summary className="explain__heading">
            {definition.name} is used {uses.length}×
          </summary>
          {uses.length === 0 ? <p className="explain__muted">No use found. It may be called in a way that cannot be seen in the code.</p> : null}
          <ul className="explain__places">
            {uses.slice(0, 60).map((u, i) => (
              <li key={i}>
                <button type="button" className="explain__link" onClick={() => onGo(u.path, u.line)}>
                  {u.path}:{u.line}
                </button>{' '}
                <EvidenceBadge level={u.evidence} />
              </li>
            ))}
            {uses.length > 60 ? <li>… and {uses.length - 60} more</li> : null}
          </ul>
        </details>
      ) : null}
      {related && related.needs.length + related.usedBy.length > 0 ? (
        <details className="explain__legend">
          <summary className="explain__heading">
            Connected files ({related.needs.length + related.usedBy.length})
          </summary>
          <ul className="explain__places">
            {related.needs.map(([p, n]) => (
              <li key={`n${p}`}>
                uses{' '}
                <button type="button" className="explain__link" onClick={() => onGo(p, 1)}>
                  {p}
                </button>{' '}
                ×{n}
              </li>
            ))}
            {related.usedBy.map(([p, n]) => (
              <li key={`u${p}`}>
                used by{' '}
                <button type="button" className="explain__link" onClick={() => onGo(p, 1)}>
                  {p}
                </button>{' '}
                ×{n}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
