import { Icon } from '../common/Icon';
import type { PlaybackSpeed, SimulationController } from './useSimulationController';
import './LabControls.css';

/** Step / play / speed controls with a scrubber. */
export function PlaybackControls({ sim }: { sim: SimulationController }) {
  const total = sim.trace?.steps.length ?? 0;
  if (total === 0) return null;
  const atEnd = sim.stepIndex >= total - 1;
  return (
    <div className="playback" role="toolbar" aria-label="Simulation playback">
      <button type="button" className="btn btn--icon btn--ghost" onClick={sim.restart} title="Restart" aria-label="Restart">
        <span aria-hidden="true">⏮</span>
      </button>
      <button type="button" className="btn btn--icon btn--ghost" onClick={sim.prev} disabled={sim.stepIndex === 0} title="Previous operation (←)" aria-label="Previous operation">
        <Icon name="chevronLeft" />
      </button>
      <button type="button" className="btn btn--primary playback__play" onClick={sim.togglePlay} title={sim.playing ? 'Pause (space)' : 'Play (space)'} aria-label={sim.playing ? 'Pause' : 'Play'}>
        <span aria-hidden="true">{sim.playing ? '❚❚' : atEnd ? '↻' : '▶'}</span>
      </button>
      <button type="button" className="btn btn--icon btn--ghost" onClick={sim.next} disabled={atEnd} title="Next operation (→)" aria-label="Next operation">
        <Icon name="chevronRight" />
      </button>
      <input
        type="range"
        className="playback__scrub"
        min={0}
        max={total - 1}
        value={sim.stepIndex}
        onChange={(e) => sim.goTo(Number(e.target.value))}
        aria-label="Step"
        aria-valuetext={`Step ${sim.stepIndex + 1} of ${total}`}
      />
      <span className="playback__count">
        {sim.stepIndex + 1}/{total}
      </span>
      <select className="playback__speed" value={sim.speed} onChange={(e) => sim.setSpeed(Number(e.target.value) as PlaybackSpeed)} aria-label="Playback speed">
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
      </select>
    </div>
  );
}

/**
 * Inputs for the run, one compact row each:
 * literal values from the code (scripts), values to make an object (class methods),
 * the function/method's own arguments, and sample rows for a missing data file.
 */
export function InputsPanel({ sim }: { sim: SimulationController }) {
  const fields = sim.inputFields;
  const init = sim.params.filter((p) => p.group === 'init');
  const call = sim.params.filter((p) => p.group === 'call');
  const data = sim.missingData;
  if (fields.length === 0 && sim.params.length === 0 && !data) return null;
  const edited = fields.some((f) => f.edited) || sim.params.some((p) => p.value);
  const isMethod = sim.scenario?.kind === 'method';
  return (
    <section className="inputs-panel">
      <p className="inputs-panel__hint">
        Edit a value, then press Enter to replay.
        {edited ? (
          <button type="button" className="btn btn--ghost inputs-panel__reset" onClick={sim.resetInputs}>
            reset all
          </button>
        ) : null}
      </p>
      {fields.length > 0 ? (
        <div className="inputs-panel__fields">
          {fields.map((f) => (
            <label key={f.input.key} className={`input-field${f.error ? ' has-error' : ''}${f.edited ? ' is-edited' : ''}`}>
              <span className="input-field__name" title={`${f.input.context} · line ${f.input.span.startLine}: ${f.input.code}`}>
                {f.input.name}
                <small>L{f.input.span.startLine}</small>
              </span>
              <input
                type="text"
                spellCheck={false}
                value={f.text}
                onChange={(e) => sim.setInputText(f.input.key, e.target.value)}
                onBlur={() => sim.commitInput(f.input.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sim.commitInput(f.input.key);
                }}
                aria-label={`${f.input.name} (${f.input.context})`}
              />
              {f.error ? <span className="input-field__error">{f.error}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
      {isMethod ? (
        <h4 className="inputs-panel__group">
          <span aria-hidden="true">🧩</span> make a {sim.scenario?.kind === 'method' ? sim.scenario.className : ''}
          {init.length === 0 ? <small> (needs no values)</small> : null}
        </h4>
      ) : null}
      <ParamRows sim={sim} params={init} />
      {isMethod && call.length > 0 ? (
        <h4 className="inputs-panel__group">
          <span aria-hidden="true">🧑‍🍳</span> {sim.scenario?.kind === 'method' ? sim.scenario.method : ''} needs
        </h4>
      ) : null}
      <ParamRows sim={sim} params={call} />
      {data ? (
        <div className="inputs-panel__data">
          <h4 className="inputs-panel__group">
            <span aria-hidden="true">📄</span> {data.path} {data.supplied ? <small>(your sample rows)</small> : <small>is not in this project: type a few rows</small>}
          </h4>
          <textarea
            spellCheck={false}
            rows={4}
            placeholder={'name,hours\nnorth,10.5\nsouth,20.0'}
            value={data.text}
            onChange={(e) => sim.setDataText(data.path, e.target.value)}
            aria-label={`Sample CSV rows for ${data.path}`}
          />
          <button type="button" className="btn btn--primary" onClick={() => sim.commitData(data.path)}>
            use these rows
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ParamRows({ sim, params }: { sim: SimulationController; params: SimulationController['params'] }) {
  if (params.length === 0) return null;
  return (
    <div className="inputs-panel__fields">
      {params.map((p) => (
        <label key={p.key} className={`input-field${p.error ? ' has-error' : ''}${p.value ? ' is-edited' : ''}`}>
          <span className="input-field__name">{p.name}</span>
          <input
            type="text"
            spellCheck={false}
            placeholder="e.g. 25.0 or [1, 2, 3]"
            value={p.text}
            onChange={(e) => sim.setParamText(p.key, e.target.value)}
            onBlur={() => sim.commitParam(p.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sim.commitParam(p.key);
            }}
            aria-label={`Value for ${p.name}`}
          />
          {p.error ? <span className="input-field__error">{p.error}</span> : null}
        </label>
      ))}
    </div>
  );
}
