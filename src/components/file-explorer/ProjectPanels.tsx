import { useEffect, useMemo, useState } from 'react';
import type { ProjectAnalysis } from '../../app/useProjectAnalysis';
import { findAssets, htmlMentions, markdownMentions, mentionsIn, styleAndScriptMentions, type AssetReport, type PathMention } from '../../core/assets/assets';
import { findLibraries, unusedRequirements, type Library, type LibraryKind } from '../../core/dependencies/libraries';
import { readManifest, type Requirement } from '../../core/dependencies/manifests';
import type { FileState } from '../../core/prepare/preparation';
import type { ProjectSource } from '../../core/repository/types';
import './ProjectPanels.css';

type Go = (path: string, line: number) => void;

// ---- Preparation status ---------------------------------------------------------------

const STATE_LABEL: Record<FileState, string> = { waiting: 'waiting', processing: 'working', prepared: 'ready', failed: 'failed', unsupported: 'no viewer' };
const STATE_ICON: Record<FileState, string> = { waiting: '○', processing: '◐', prepared: '●', failed: '✗', unsupported: '–' };

const seconds = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function StatusPanel({ analysis, onOpen }: { analysis: ProjectAnalysis; onOpen: (path: string) => void }) {
  const s = analysis.snapshot;
  const [filter, setFilter] = useState<FileState | 'all'>('all');
  const gaps = useMemo(() => {
    let statements = 0;
    let understood = 0;
    let errors = 0;
    let disagree = 0;
    let checked = 0;
    for (const a of analysis.analyses.values()) {
      statements += a.coverage.statements;
      understood += a.coverage.understood;
      if (a.coverage.syntaxErrors > 0) errors++;
      if (a.check) {
        checked++;
        if (!a.check.agree) disagree++;
      }
    }
    return { statements, understood, errors, disagree, checked };
  }, [analysis.analyses]);
  if (!s) return <p className="project-panel__note">Reading the files…</p>;
  const list = [...analysis.statuses].filter(([, v]) => filter === 'all' || v.state === filter);
  return (
    <div className="project-panel">
      <div className="status-box" role="status">
        <b>{s.state === 'done' ? 'all files prepared' : s.state === 'paused' ? 'paused' : s.state === 'cancelled' ? 'stopped' : 'preparing…'}</b>
        <progress max={s.total} value={s.total - s.remaining} aria-label="Preparation" />
        <span>
          {s.total - s.remaining} of {s.total} files{s.stored > 0 ? ` · ${s.stored} from last time` : ''} · {seconds(s.elapsedMs)}
          {s.etaMs !== null ? ` · about ${seconds(s.etaMs)} left` : ''}
        </span>
        {s.current.length > 0 ? <small className="status-box__current">{s.current.join(', ')}</small> : null}
        <span className="status-box__buttons">
          {s.state === 'running' ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={analysis.pause}>
                pause
              </button>
              <button type="button" className="btn btn--ghost" onClick={analysis.cancel}>
                stop
              </button>
            </>
          ) : s.state === 'paused' ? (
            <button type="button" className="btn btn--ghost" onClick={analysis.resume}>
              go on
            </button>
          ) : s.state === 'cancelled' || s.failed > 0 ? (
            <button type="button" className="btn btn--ghost" onClick={analysis.restart}>
              try again
            </button>
          ) : null}
        </span>
      </div>
      {gaps.statements > 0 ? (
        <p className="project-panel__note">
          Statements read: {gaps.understood} of {gaps.statements} ({((100 * gaps.understood) / gaps.statements).toFixed(1)} %).
          {gaps.errors > 0 ? ` Files with syntax errors: ${gaps.errors}.` : ''}
          {gaps.checked > 0 ? ` Second parser agrees in ${gaps.checked - gaps.disagree} of ${gaps.checked} files.` : ''}
        </p>
      ) : null}
      <div className="project-panel__filter" role="radiogroup" aria-label="Show files">
        {(['all', 'waiting', 'processing', 'prepared', 'failed', 'unsupported'] as const).map((f) => {
          const n = f === 'all' ? analysis.statuses.size : [...analysis.statuses.values()].filter((v) => v.state === f).length;
          return n === 0 && f !== 'all' ? null : (
            <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'all' : STATE_LABEL[f]} {n}
            </button>
          );
        })}
      </div>
      <ul className="project-panel__list">
        {list.slice(0, 500).map(([path, v]) => (
          <li key={path}>
            <button type="button" onClick={() => onOpen(path)} title={v.reason ?? STATE_LABEL[v.state]}>
              <span className={`status-dot is-${v.state}`} aria-label={STATE_LABEL[v.state]}>
                {STATE_ICON[v.state]}
              </span>
              <span className="project-panel__path">{path}</span>
            </button>
            {v.reason ? <small>{v.reason}</small> : null}
          </li>
        ))}
        {list.length > 500 ? <li className="project-panel__note">… and {list.length - 500} more</li> : null}
      </ul>
    </div>
  );
}

// ---- Libraries ---------------------------------------------------------------------------

const KIND_LABEL: Record<LibraryKind, string> = { 'third-party': 'packages', stdlib: 'standard library', builtin: 'built into Python', internal: 'this project' };

export function LibrariesPanel({ project, analysis, onGo }: { project: ProjectSource; analysis: ProjectAnalysis; onGo: Go }) {
  const [requirements, setRequirements] = useState<readonly Requirement[]>([]);
  const [problems, setProblems] = useState<ReadonlyArray<{ path: string; problem: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: Requirement[] = [];
      const bad: Array<{ path: string; problem: string }> = [];
      for (const f of project.files.filter((x) => x.category === 'dependency-manifest' && x.size < 1024 ** 2).slice(0, 50)) {
        try {
          const r = await readManifest(f.path, (await project.readText(f.path)).replace(/\r\n?/g, '\n'));
          found.push(...r.requirements);
          if (r.problem) bad.push({ path: f.path, problem: r.problem });
        } catch (err) {
          bad.push({ path: f.path, problem: err instanceof Error ? err.message : String(err) });
        }
      }
      if (!cancelled) {
        setRequirements(found);
        setProblems(bad);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);
  const libraries = useMemo(() => findLibraries(analysis.analyses, requirements), [analysis.analyses, requirements]);
  const unused = useMemo(() => unusedRequirements(libraries, requirements), [libraries, requirements]);
  if (analysis.analyses.size === 0) return <p className="project-panel__note">Preparing…</p>;
  const groups: LibraryKind[] = ['third-party', 'stdlib', 'builtin', 'internal'];
  return (
    <div className="project-panel">
      {groups.map((kind) => {
        const list = libraries.filter((l) => l.kind === kind);
        return list.length === 0 ? null : (
          <section key={kind}>
            <h4>
              {KIND_LABEL[kind]} <small>{list.length}</small>
            </h4>
            {list.map((l) => (
              <LibraryRow key={l.name} library={l} onGo={onGo} />
            ))}
          </section>
        );
      })}
      {unused.length > 0 ? (
        <section>
          <h4>
            asked for, not imported <small>{unused.length}</small>
          </h4>
          <p className="project-panel__note">Named in project files, but no analysed code imports them by a known name.</p>
          <ul className="project-panel__list">
            {unused.map((r, i) => (
              <li key={i}>
                <button type="button" onClick={() => onGo(r.file, r.line ?? 1)}>
                  <span className="project-panel__path">
                    {r.name} {r.spec}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {problems.map((p) => (
        <p key={p.path} className="project-panel__note is-problem">
          {p.path}: {p.problem}
        </p>
      ))}
    </div>
  );
}

function LibraryRow({ library: l, onGo }: { library: Library; onGo: Go }) {
  const [open, setOpen] = useState(false);
  const spec = [...new Set(l.requirements.map((r) => r.spec).filter(Boolean))].join(' or ');
  return (
    <details className="library" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <b>{l.kind === 'internal' ? l.name : (l.distribution ?? l.name)}</b>
        {l.kind === 'third-party' ? <span className={spec ? 'library__version' : 'library__version is-unknown'}>{spec || (l.requirements.length ? 'any version' : 'version unknown')}</span> : null}
        <small>{l.imports.length > 0 ? `${new Set(l.imports.map((i) => i.path)).size} files` : `${l.uses.length} names`}</small>
      </summary>
      {open ? (
        <div className="library__body">
          {l.purpose ? <p>{l.purpose}</p> : l.kind === 'third-party' ? <p className="project-panel__note">What it does is not in the built-in catalogue.</p> : null}
          {l.docs ? (
            <p>
              <a href={l.docs} target="_blank" rel="noreferrer noopener">
                documentation
              </a>{' '}
              <small>{l.kind === 'third-party' ? (l.docsForVersion ? 'for the version asked for' : 'newest version') : ''}</small>
            </p>
          ) : null}
          {l.kind === 'third-party' && l.distribution !== l.name ? <p>imported as {l.name}</p> : null}
          {l.aliases.length > 0 ? <p>{l.aliases.join(', ')}</p> : null}
          <ul className="project-panel__list">
            {l.uses.slice(0, 60).map((u) => (
              <li key={u.name}>
                <button type="button" onClick={() => onGo(u.places[0]!.path, u.places[0]!.line)} title={u.places.slice(0, 12).map((p) => `${p.path}:${p.line}`).join('\n')}>
                  <code>{u.name}</code> <small>×{u.places.length}</small>
                </button>
              </li>
            ))}
            {l.uses.length > 60 ? <li className="project-panel__note">… and {l.uses.length - 60} more</li> : null}
            {l.imports.slice(0, 20).map((i, k) => (
              <li key={`i${k}`}>
                <button type="button" onClick={() => onGo(i.path, i.line)}>
                  <span className="project-panel__path">
                    imported in {i.path}:{i.line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
}

// ---- Assets ------------------------------------------------------------------------------

const MENTION_LIMIT = 1024 ** 2;

export function useAssets(project: ProjectSource, analysis: ProjectAnalysis, active: boolean): AssetReport | null {
  const [texts, setTexts] = useState<readonly PathMention[] | null>(null);
  useEffect(() => {
    if (!active || texts) return;
    let cancelled = false;
    void (async () => {
      const out: PathMention[] = [];
      for (const f of project.files.filter((x) => ['markdown', 'html', 'css', 'javascript'].includes(x.category) && x.size < MENTION_LIMIT).slice(0, 500)) {
        try {
          const text = (await project.readText(f.path)).replace(/\r\n?/g, '\n');
          out.push(...(f.category === 'markdown' ? markdownMentions(f.path, text) : f.category === 'html' ? htmlMentions(f.path, text) : styleAndScriptMentions(f.path, text)));
        } catch {
          // Unreadable files mention nothing that could be shown.
        }
      }
      if (!cancelled) setTexts(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [project, active, texts]);
  return useMemo(() => (texts ? findAssets(project.files, [...mentionsIn(analysis.analyses.values()), ...texts]) : null), [project, analysis.analyses, texts]);
}

export function AssetsPanel({ report, onGo, onOpen }: { report: AssetReport | null; onGo: Go; onOpen: (path: string) => void }) {
  if (!report) return <p className="project-panel__note">Looking for mentions…</p>;
  const groups = ['image', 'data', 'configuration', 'document', 'other'] as const;
  return (
    <div className="project-panel">
      {groups.map((g) => {
        const list = report.assets.filter((a) => a.group === g);
        return list.length === 0 ? null : (
          <section key={g}>
            <h4>
              {g === 'image' ? 'images' : g === 'document' ? 'documents' : g} <small>{list.length}</small>
            </h4>
            <ul className="project-panel__list">
              {list.slice(0, 300).map((a) => (
                <li key={a.file.path}>
                  <button type="button" onClick={() => onOpen(a.file.path)}>
                    <span className="project-panel__path">{a.file.path}</span>
                    <small>{a.references.length === 0 ? 'no mention found' : `${a.references.length}×`}</small>
                  </button>
                  {a.references.slice(0, 5).map((r, i) => (
                    <button key={i} type="button" className="asset-ref" onClick={() => onGo(r.mention.path, r.mention.line)} title={r.reason}>
                      <span className={`asset-ref__mark is-${r.certainty}`}>{r.certainty}</span> {r.mention.path}:{r.mention.line}
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {report.unresolved.length > 0 ? (
        <details className="library">
          <summary>
            <b>paths without a file</b> <small>{report.unresolved.length}</small>
          </summary>
          <ul className="project-panel__list">
            {report.unresolved.slice(0, 200).map((u, i) => (
              <li key={i}>
                <button type="button" onClick={() => onGo(u.mention.path, u.mention.line)} title={u.reason}>
                  <code>{u.mention.text}</code>
                  <span className="project-panel__path">
                    {u.mention.path}:{u.mention.line}
                  </span>
                </button>
                <small>{u.reason}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
