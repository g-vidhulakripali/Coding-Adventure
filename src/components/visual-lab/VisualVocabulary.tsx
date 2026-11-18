import type { JSX } from 'react';

/**
 * The laboratory's visual vocabulary: one shape and one colour per concept,
 * used consistently by every future scene. Rendered here as a legend so the
 * metaphors are learnable before any code is explored.
 *
 * These glyphs are illustrations of the design language only — the values in
 * them are placeholders, not analysis output.
 */

interface VocabularyItem {
  readonly id: string;
  readonly name: string;
  readonly meaning: string;
  readonly colorVar: string;
  readonly glyph: JSX.Element;
}

const ITEMS: readonly VocabularyItem[] = [
  {
    id: 'variable',
    name: 'Variable',
    meaning: 'A labelled container that holds a value',
    colorVar: '--lab-variable',
    glyph: (
      <svg viewBox="0 0 64 40">
        <rect x="6" y="10" width="52" height="26" rx="6" className="vg-stroke" />
        <rect x="6" y="4" width="26" height="10" rx="4" className="vg-fill" />
        <rect x="22" y="18" width="20" height="10" rx="5" className="vg-value" />
      </svg>
    ),
  },
  {
    id: 'value',
    name: 'Value',
    meaning: 'A piece of data that moves between operations',
    colorVar: '--lab-value',
    glyph: (
      <svg viewBox="0 0 64 40">
        <rect x="16" y="13" width="32" height="14" rx="7" className="vg-fill" />
        <path d="M4 20h8M52 20h8" className="vg-motion" />
      </svg>
    ),
  },
  {
    id: 'collection',
    name: 'Collection',
    meaning: 'A list, array or series of elements; indexing picks one',
    colorVar: '--lab-collection',
    glyph: (
      <svg viewBox="0 0 64 40">
        <rect x="6" y="12" width="16" height="16" rx="3" className="vg-stroke" />
        <rect x="24" y="12" width="16" height="16" rx="3" className="vg-stroke" />
        <rect x="42" y="12" width="16" height="16" rx="3" className="vg-fill" />
        <path d="M50 4v5" className="vg-motion" />
      </svg>
    ),
  },
  {
    id: 'function',
    name: 'Function',
    meaning: 'A machine: inputs go in, a result comes out',
    colorVar: '--lab-function',
    glyph: (
      <svg viewBox="0 0 64 40">
        <path d="M2 14h12M2 26h12M50 20h12" className="vg-motion" />
        <rect x="14" y="6" width="36" height="28" rx="7" className="vg-fill" />
        <circle cx="32" cy="20" r="6" className="vg-hole" />
      </svg>
    ),
  },
  {
    id: 'decision',
    name: 'Decision',
    meaning: 'A condition that sends execution down one branch',
    colorVar: '--lab-decision',
    glyph: (
      <svg viewBox="0 0 64 40">
        <path d="M32 4 48 20 32 36 16 20z" className="vg-fill" />
        <path d="M48 20h12M32 36v2M16 20H4" className="vg-motion" />
      </svg>
    ),
  },
  {
    id: 'loop',
    name: 'Loop',
    meaning: 'Repeated processing, one item or pass at a time',
    colorVar: '--lab-loop',
    glyph: (
      <svg viewBox="0 0 64 40">
        <path d="M44 10a14 12 0 1 1-24 0" className="vg-thick" />
        <path d="m40 4 5 6-7 3" className="vg-thick" />
      </svg>
    ),
  },
  {
    id: 'return',
    name: 'Return',
    meaning: 'A value travelling back to the caller',
    colorVar: '--lab-return',
    glyph: (
      <svg viewBox="0 0 64 40">
        <path d="M56 12v6a6 6 0 0 1-6 6H12" className="vg-thick" />
        <path d="m18 17-7 7 7 7" className="vg-thick" />
      </svg>
    ),
  },
];

export function VisualVocabulary() {
  return (
    <section className="vocab" aria-labelledby="vocab-title">
      <h4 id="vocab-title" className="vocab__title">
        Visual vocabulary
      </h4>
      <ul className="vocab__grid">
        {ITEMS.map((item) => (
          <li key={item.id} className="vocab__item" style={{ color: `var(${item.colorVar})` }}>
            <span className="vocab__glyph" aria-hidden="true">
              {item.glyph}
            </span>
            <span className="vocab__text">
              <strong>{item.name}</strong>
              <span>{item.meaning}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
