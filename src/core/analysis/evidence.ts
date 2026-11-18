/**
 * Evidence levels.
 *
 * Every statement the application makes about code carries one of these
 * levels, so users can always tell how much to trust it. The UI must never
 * blur them together — in particular, a simulation is never presented as
 * proof of real Python runtime behaviour.
 */
export type EvidenceLevel = 'verified' | 'static' | 'inferred' | 'simulated' | 'unsupported';

export interface EvidenceInfo {
  readonly label: string;
  readonly description: string;
  /** CSS custom property holding the badge colour. */
  readonly colorVar: string;
}

export const EVIDENCE_INFO: Record<EvidenceLevel, EvidenceInfo> = {
  verified: {
    label: 'Verified source',
    description: 'Read directly from the original file — exact text, exact location.',
    colorVar: '--evidence-verified',
  },
  static: {
    label: 'Static analysis',
    description: 'Derived by parsing the code without running it.',
    colorVar: '--evidence-static',
  },
  inferred: {
    label: 'Inferred',
    description: 'A likely interpretation that the parser cannot prove (e.g. a dynamically resolved call).',
    colorVar: '--evidence-inferred',
  },
  simulated: {
    label: 'Simulated',
    description: 'Produced by a controlled JavaScript model of the operation — not real Python execution.',
    colorVar: '--evidence-simulated',
  },
  unsupported: {
    label: 'Unsupported',
    description: 'Not understood by the current analysis. Shown so nothing is silently skipped.',
    colorVar: '--evidence-unsupported',
  },
};

export const EVIDENCE_ORDER: readonly EvidenceLevel[] = ['verified', 'static', 'inferred', 'simulated', 'unsupported'];
