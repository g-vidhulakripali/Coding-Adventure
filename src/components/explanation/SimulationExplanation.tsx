import { displayValue, typeLabel } from '../../core/simulation/values';
import { buildScene, describeDestination } from '../../core/visualisation/scene';
import { InlineCode } from '../visual-lab/InlineCode';
import type { SimulationController } from '../visual-lab/useSimulationController';
import { EvidenceBadge } from './EvidenceBadge';

/** Explanation of the current simulation step: what, why, values, next, variables, run notes. */
export function SimulationExplanation({ sim }: { sim: SimulationController }) {
  const { trace, step } = sim;
  if (!trace || !step) return null;
  const scene = buildScene(trace, sim.stepIndex);
  const usedBy = step.usedBy !== null ? trace.steps[step.usedBy] : null;

  return (
    <>
      <section className="explain__section">
        <h3 className="explain__heading">
          Step {step.id + 1} of {trace.steps.length}
        </h3>
        <div className="explain__step-title">
          <b>{step.title}</b>
          <EvidenceBadge level={step.evidence} />
        </div>
        <p className="explain__lead">
          <InlineCode text={step.explanation.what} />
        </p>
        <p className="explain__why">
          <span>Why</span> <InlineCode text={step.explanation.why} />
        </p>
        {step.inputs.length > 0 ? (
          <div className="explain__io">
            <span>In</span>
            <ul>
              {step.inputs.map((i, n) => (
                <li key={n}>
                  <code>{i.name && i.name !== i.label ? `${i.name} ← ${i.label}` : i.label}</code> = <b>{displayValue(i.value)}</b> <small>{typeLabel(i.value)}</small>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {step.output && step.kind !== 'print' ? (
          <div className="explain__io">
            <span>Out</span>
            <ul>
              <li>
                <b>{displayValue(step.output, 80)}</b> <small>{typeLabel(step.output)}</small>
              </li>
            </ul>
          </div>
        ) : null}
        {scene ? (
          <div className="explain__io">
            <span>Next</span>
            <ul>
              <li>
                <InlineCode text={describeDestination(scene.operation.destination, scene.frames)} />
                {usedBy ? (
                  <>
                    {' — '}
                    <button type="button" className="explain__link" onClick={() => sim.goTo(usedBy.id)}>
                      step {usedBy.id + 1}
                    </button>{' '}
                    <code>{usedBy.code.replace(/\s+/g, ' ').trim().slice(0, 40)}</code>
                  </>
                ) : null}
              </li>
            </ul>
          </div>
        ) : null}
        {step.notes.map((n, i) => (
          <p key={i} className="explain__note">
            <InlineCode text={n} />
          </p>
        ))}
      </section>

      <section className="explain__section">
        <h3 className="explain__heading">Variables</h3>
        {[...step.frames].reverse().map((f) => {
          const vars = f.vars.filter((v) => !['function', 'builtin', 'module', 'class', 'method', 'iloc'].includes(v.value.t));
          return (
            <div key={f.id} className={`explain__frame${f.id === step.frameId ? ' is-current' : ''}`}>
              <div className="explain__frame-name">{f.name === '<simulation>' ? 'your inputs' : f.kind === 'module' ? f.path : `${f.name}() · ${f.path}`}</div>
              {vars.length === 0 ? (
                <p className="explain__muted">no variables</p>
              ) : (
                <table className="explain__vars">
                  <tbody>
                    {vars.map((v) => (
                      <tr key={v.name} className={v.setAt === step.id ? 'is-changed' : undefined}>
                        <th scope="row">{v.name}</th>
                        <td>{displayValue(v.value, 36)}</td>
                        <td>{typeLabel(v.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </section>

      {step.consoleLength > 0 ? (
        <section className="explain__section">
          <h3 className="explain__heading">Console</h3>
          <pre className="explain__console">{trace.console.slice(0, step.consoleLength).join('\n')}</pre>
        </section>
      ) : null}

      <details className="explain__section explain__legend">
        <summary className="explain__heading">About this run</summary>
        <ul className="explain__run">
          <li>{trace.entryLabel}.</li>
          <li>
            Simulated by a JavaScript model of the operations. Python is not executed, so this is not proof of real runtime behaviour.
          </li>
          {trace.assumptions.map((a, i) => (
            <li key={i}>
              <InlineCode text={a} />
            </li>
          ))}
          {trace.stop ? <li className="explain__stop">Stopped: {trace.stop.message}</li> : null}
          {trace.skipped.length > 0 ? (
            <li>
              Not shown as steps:{' '}
              {trace.skipped.map((s, i) => (
                <span key={i}>
                  {i > 0 ? '; ' : ''}
                  {s.reason} ({s.span.path}:{s.span.startLine})
                </span>
              ))}
              .
            </li>
          ) : null}
        </ul>
      </details>
    </>
  );
}
