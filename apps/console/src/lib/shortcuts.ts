import { SCREENS } from './screens.ts'

/** A key as `@tanstack/react-hotkeys` names it: a chord (`Mod+K`, `?`) or a sequence (`['G', 'O']`). */
export type ShortcutKeys = string | readonly [string, string]

export interface Shortcut {
  keys: ShortcutKeys
  label: string
}

export interface ShortcutGroup {
  title: string
  items: readonly Shortcut[]
}

/**
 * Every key the Console binds, by group: the help overlay (`?`) lists exactly these, and `components/shell.tsx` binds them
 * (a page binds `[` and `]` through `useWindowKeys`). A new binding gets its line here first.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Go to',
    items: SCREENS.map((item) => ({ keys: ['G', item.key] as const, label: item.label })),
  },
  {
    title: 'Anywhere',
    items: [
      { keys: 'Mod+K', label: 'Open the command palette' },
      { keys: '?', label: 'Show the keyboard shortcuts' },
      { keys: '/', label: "Focus the page's filter, or search where it has none" },
      { keys: 'Escape', label: 'Close the panel, or go back from a page' },
    ],
  },
  {
    title: 'Lists and tables',
    items: [
      { keys: 'J', label: 'Next row' },
      { keys: 'K', label: 'Previous row' },
      { keys: 'Enter', label: 'Open the row' },
    ],
  },
  {
    title: 'Charts',
    items: [
      { keys: '[', label: 'Shorter window' },
      { keys: ']', label: 'Longer window' },
    ],
  },
]

/** The rows `j` and `k` step through: a page marks each row's link or button with `data-keynav`. */
export const KEYNAV_SELECTOR = 'main [data-keynav]'

/**
 * The index `j` (+1) or `k` (-1) moves to among `count` rows from `current` (-1: none focused). The first press with
 * nothing focused takes the first row (or the last for `k`); the ends hold, they do not wrap.
 */
export function stepIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return step === 1 ? 0 : count - 1
  return Math.min(Math.max(current + step, 0), count - 1)
}

/** The window `[` (-1) or `]` (+1) picks from ordered choices; the ends hold. */
export function stepChoice<T>(choices: readonly T[], value: T, step: 1 | -1): T {
  const at = choices.indexOf(value)
  const next = choices[Math.min(Math.max(Math.max(0, at) + step, 0), choices.length - 1)]
  return next === undefined ? value : next
}

/** A page that is one thing (an Issue, an artifact, a project's tab, a checkpoint): Escape goes back from it. */
const PAGE_OF_A_THING = /^\/(issues|artifacts|projects|checkpoints)\/[^/]+/

/** Where Escape leaves a page of one thing to when there is no history to go back to: the list it belongs to. */
export function parentOf(pathname: string): string | null {
  if (!PAGE_OF_A_THING.test(pathname)) return null
  if (pathname.startsWith('/issues/') || pathname.startsWith('/checkpoints/')) return '/'
  if (pathname.startsWith('/artifacts/')) return '/artifacts'
  return '/projects'
}
