import type { ReactNode } from 'react';
import { navigate } from '../../app/router';
import type { ThemePreference } from '../../hooks/useTheme';
import { Icon, type IconName } from '../common/Icon';
import './AppHeader.css';

const THEME_CYCLE: Record<ThemePreference, { next: ThemePreference; icon: IconName; label: string }> = {
  system: { next: 'light', icon: 'monitor', label: 'Theme: system' },
  light: { next: 'dark', icon: 'sun', label: 'Theme: light' },
  dark: { next: 'system', icon: 'moon', label: 'Theme: dark' },
};

export interface AppHeaderProps {
  readonly theme: ThemePreference;
  readonly onThemeChange: (theme: ThemePreference) => void;
  /** Middle slot, e.g. project name and breadcrumbs. */
  readonly center?: ReactNode;
  /** Right slot before the theme toggle, e.g. layout controls. */
  readonly controls?: ReactNode;
}

export function AppHeader({ theme, onThemeChange, center, controls }: AppHeaderProps) {
  const themeInfo = THEME_CYCLE[theme];
  return (
    <header className="app-header">
      <a
        className="app-header__brand"
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          navigate({ name: 'home' });
        }}
      >
        <BrandMark />
        <span className="app-header__name">Code Playground</span>
      </a>
      <div className="app-header__center">{center}</div>
      <div className="app-header__controls">
        {controls}
        <button
          type="button"
          className="btn btn--icon btn--ghost"
          onClick={() => onThemeChange(themeInfo.next)}
          title={`${themeInfo.label} (click to change)`}
          aria-label={`${themeInfo.label}. Switch to ${themeInfo.next}.`}
        >
          <Icon name={themeInfo.icon} />
        </button>
      </div>
    </header>
  );
}

export function BrandMark({ size = 28 }: { size?: number }) {
  // Terminal-prompt mark: ">_" on an editor tile, with the lab's value colour as the cursor.
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="brand-mark">
      <rect width="64" height="64" rx="12" fill="var(--code-bg)" stroke="var(--color-border-strong)" strokeWidth="2" />
      <path d="M16 22l12 10-12 10" fill="none" stroke="var(--color-accent)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="32" y="40" width="18" height="6" rx="3" fill="var(--lab-value)" />
    </svg>
  );
}
