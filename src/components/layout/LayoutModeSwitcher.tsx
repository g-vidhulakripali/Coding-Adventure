import { LAYOUT_MODES, type LayoutMode } from './layoutModes';
import './LayoutModeSwitcher.css';

/** Miniature diagram of each layout so the choice is recognisable at a glance. */
function ModeGlyph({ mode }: { mode: LayoutMode }) {
  const blocks: Record<LayoutMode, Array<[number, number, string]>> = {
    'code-lab-explain': [
      [1, 6, 'code'],
      [8, 7, 'lab'],
      [16, 3, 'explain'],
    ],
    'code-lab': [
      [1, 8, 'code'],
      [10, 9, 'lab'],
    ],
    code: [[1, 18, 'code']],
    lab: [[1, 18, 'lab']],
  };
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true" className="mode-glyph">
      {blocks[mode].map(([x, w, kind]) => (
        <rect key={kind} x={x} y={1} width={w} height={12} rx={1.5} className={`mode-glyph__${kind}`} />
      ))}
    </svg>
  );
}

export function LayoutModeSwitcher({ mode, onChange }: { mode: LayoutMode; onChange: (mode: LayoutMode) => void }) {
  return (
    <div className="mode-switcher" role="radiogroup" aria-label="Workspace layout">
      {LAYOUT_MODES.map((info) => (
        <button
          key={info.id}
          type="button"
          role="radio"
          aria-checked={mode === info.id}
          className="mode-switcher__option"
          title={`${info.label} (Alt+${info.shortcut})`}
          onClick={() => onChange(info.id)}
        >
          <ModeGlyph mode={info.id} />
          <span className="visually-hidden">{info.label}</span>
        </button>
      ))}
    </div>
  );
}
