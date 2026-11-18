import { EVIDENCE_INFO, type EvidenceLevel } from '../../core/analysis/evidence';
import './EvidenceBadge.css';

/** Small coloured badge stating how a fact was obtained. */
export function EvidenceBadge({ level }: { level: EvidenceLevel }) {
  const info = EVIDENCE_INFO[level];
  return (
    <span className={`evidence-badge evidence-badge--${level}`} style={{ color: `var(${info.colorVar})` }} title={info.description}>
      <span className="evidence-badge__dot" aria-hidden="true" />
      {info.label}
    </span>
  );
}
