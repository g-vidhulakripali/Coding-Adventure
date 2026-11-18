/**
 * Workspace layout modes. The three-panel mode is the default desktop layout.
 */
export type LayoutMode = 'code-lab-explain' | 'code-lab' | 'code' | 'lab';

export interface LayoutModeInfo {
  readonly id: LayoutMode;
  readonly label: string;
  readonly shortcut: string;
  readonly showCode: boolean;
  readonly showLab: boolean;
  readonly showExplanation: boolean;
}

export const LAYOUT_MODES: readonly LayoutModeInfo[] = [
  { id: 'code-lab-explain', label: 'Code + Lab + Explain', shortcut: '1', showCode: true, showLab: true, showExplanation: true },
  { id: 'code-lab', label: 'Code + Lab', shortcut: '2', showCode: true, showLab: true, showExplanation: false },
  { id: 'code', label: 'Code only', shortcut: '3', showCode: true, showLab: false, showExplanation: false },
  { id: 'lab', label: 'Lab only', shortcut: '4', showCode: false, showLab: true, showExplanation: false },
];

export const DEFAULT_LAYOUT_MODE: LayoutMode = 'code-lab-explain';

export function isLayoutMode(value: unknown): value is LayoutMode {
  return LAYOUT_MODES.some((m) => m.id === value);
}

export function layoutModeInfo(mode: LayoutMode): LayoutModeInfo {
  return LAYOUT_MODES.find((m) => m.id === mode) ?? LAYOUT_MODES[0]!;
}

/** Panels addressable in the narrow (stacked) layout. */
export type CompactPanel = 'files' | 'code' | 'lab' | 'explain';
