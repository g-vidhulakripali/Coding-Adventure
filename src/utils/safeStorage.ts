/**
 * localStorage wrapper for small per-browser UI preferences (theme, layout,
 * panel sizes). Every access is guarded: storage can be unavailable in private
 * windows, blocked by policy, or full. Callers always receive a fallback.
 *
 * Project data does NOT go here — it goes to IndexedDB/OPFS (Phase 6).
 */

const PREFIX = 'code-playground:';

export function readPreference<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}
