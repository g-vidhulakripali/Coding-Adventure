import type { Step, Trace } from '../../core/simulation/trace';
import { displayValue, typeLabel } from '../../core/simulation/values';
import { describeDestination, type Scene } from '../../core/visualisation/scene';
import { EvidenceBadge } from '../explanation/EvidenceBadge';
import { InlineCode } from './InlineCode';
import './StepCard.css';

export interface StepCardProps {
  readonly trace: Trace;
  readonly step: Step;
  readonly scene: Scene;
  readonly onJump: (stepIndex: number) => void;
}

/**
 * The facts of the current operation, always visible under the stage:
 * exact code · inputs · what happens · output · where it goes next.
 */
export function StepCard({ trace, step, scene, onJump }: StepCardProps) {
  const usedBy = step.usedBy !== null ? trace.steps[step.usedBy] : null;
  return (
    <section className={`step-card is-${step.kind}`} aria-live="polite" aria-label={`Step ${step.id + 1}: ${step.title}`}>
      <header className="step-card__head">
        <span className="step-card__num">
          {step.id + 1}/{trace.steps.length}
        </span>
        <span className={`step-card__title is-${step.role}`}>{step.title}</span>
        <EvidenceBadge level={step.evidence} />
      </header>
      <p className="step-card__plain">
        <span aria-hidden="true">{scene.story.icon}</span> {scene.story.headline}
        {scene.story.next ? <span className="step-card__plain-next"> {scene.story.next}</span> : null}
      </p>
      <dl className="step-card__grid">
        <dt>Code</dt>
        <dd>
          <code className="step-card__code">{step.code.replace(/\s+/g, ' ').trim()}</code>
          <span className="step-card__loc">
            {step.span.path}:{step.span.startLine}
          </span>
        </dd>
        {step.inputs.length > 0 ? (
          <>
            <dt>In</dt>
            <dd className="step-card__inputs">
              {step.inputs.map((input, i) => (
                <span key={i} className="step-card__input">
                  <code>{input.name && input.name !== input.label ? `${input.name} ← ${input.label}` : input.label}</code>
                  <b>{displayValue(input.value)}</b>
                  <small>{typeLabel(input.value)}</small>
                  {input.fromStep !== null ? (
                    <button type="button" className="step-card__link" onClick={() => onJump(input.fromStep!)} title="Go to the step that produced this value">
                      from step {input.fromStep + 1}
                    </button>
                  ) : null}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        <dt>Does</dt>
        <dd>
          <InlineCode text={step.explanation.what} />
        </dd>
        {step.output && step.kind !== 'print' ? (
          <>
            <dt>Out</dt>
            <dd>
              <b className="step-card__out">{displayValue(step.output, 80)}</b> <small>{typeLabel(step.output)}</small>
            </dd>
          </>
        ) : null}
        <dt>Next</dt>
        <dd>
          <InlineCode text={describeDestination(scene.operation.destination, scene.frames)} />
          {usedBy ? (
            <>
              {' · '}
              <button type="button" className="step-card__link" onClick={() => onJump(usedBy.id)}>
                used by step {usedBy.id + 1}
              </button>{' '}
              <code>{usedBy.code.replace(/\s+/g, ' ').trim().slice(0, 48)}</code>
            </>
          ) : null}
        </dd>
      </dl>
      {step.notes.length > 0 ? (
        <ul className="step-card__notes">
          {step.notes.map((n, i) => (
            <li key={i}>
              <InlineCode text={n} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
