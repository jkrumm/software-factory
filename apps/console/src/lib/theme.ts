export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'console-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export const resolveTheme = (preference: ThemePreference, osPrefersDark: boolean): Theme =>
  preference === 'system' ? (osPrefersDark ? 'dark' : 'light') : preference

export function storedPreference(): ThemePreference {
  const value = localStorage.getItem(KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

function apply(preference: ThemePreference) {
  document.documentElement.dataset.theme = resolveTheme(preference, matchMedia(DARK_QUERY).matches)
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
