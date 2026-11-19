export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'console-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const resolveTheme = (preference: ThemePreference, osPrefersDark: boolean): Theme =>
  preference === 'system' ? (osPrefersDark ? 'dark' : 'light') : preference

function storedPreference(): ThemePreference {
  const value = localStorage.getItem(KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

const listeners = new Set<(theme: Theme) => void>()

/** The theme the Console shows now: what an artifact's frame is told. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Calls `listener` with the resolved theme each time it changes (the toggle, or the system while the preference is `system`). */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function apply(preference: ThemePreference) {
  const before = document.documentElement.dataset.theme
  document.documentElement.dataset.theme = resolveTheme(preference, matchMedia(DARK_QUERY).matches)
  if (before !== document.documentElement.dataset.theme) for (const listener of listeners) listener(currentTheme())
}

/** Sets `data-theme` before first render and follows the OS while the preference is `system`. */
export function initTheme() {
  apply(storedPreference())
  matchMedia(DARK_QUERY).addEventListener('change', () => apply(storedPreference()))
}

export function setThemePreference(preference: ThemePreference) {
  if (preference === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, preference)
  apply(preference)
}
