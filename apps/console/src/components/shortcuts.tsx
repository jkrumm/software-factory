import { useHotkey, useHotkeys } from '@tanstack/react-hotkeys'
import { KEYNAV_SELECTOR, stepChoice, stepIndex } from '@/lib/shortcuts'

/** Moves the focus to the next (`J`) or previous (`K`) row a page marked with `data-keynav`; Enter then opens it. */
export function useListKeys(enabled: boolean): void {
  const step = (by: 1 | -1) => {
    const rows = [...document.querySelectorAll<HTMLElement>(KEYNAV_SELECTOR)].filter(
      (row) => row.offsetParent !== null || row.getClientRects().length > 0,
    )
    const active = document.activeElement
    const current = rows.findIndex((row) => row === active || row.contains(active))
    const next = rows[stepIndex(current, rows.length, by)]
    if (!next) return
    next.focus({ preventScroll: true })
    next.scrollIntoView({ block: 'nearest' })
  }
  useHotkeys(
    [
      { hotkey: 'J', callback: () => step(1) },
      { hotkey: 'K', callback: () => step(-1) },
    ],
    { enabled },
  )
}

/** `[` and `]` step a chart's window through its ordered choices (shorter, longer); the ends hold. */
export function useWindowKeys<T>(choices: readonly T[], value: T, onChange: (next: T) => void): void {
  useHotkey('[', () => onChange(stepChoice(choices, value, -1)))
  useHotkey(']', () => onChange(stepChoice(choices, value, 1)))
}
