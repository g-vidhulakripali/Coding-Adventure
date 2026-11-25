import { useEffect } from 'react';
import { usePreference } from './usePreference';

export type ThemePreference = 'system' | 'light' | 'dark';

const isTheme = (v: unknown): v is ThemePreference => v === 'system' || v === 'light' || v === 'dark';

/**
 * Theme preference. `system` follows `prefers-color-scheme`; the CSS handles
 * that case, so we only set `data-theme` for an explicit choice.
 */
export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [theme, setTheme] = usePreference<ThemePreference>('theme', 'dark', isTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return [theme, setTheme];
}
