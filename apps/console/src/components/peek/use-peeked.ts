import { useRouterState } from '@tanstack/react-router'
import { peekOf } from '@/lib/peek'

/** Whether this Issue is the one open in the peek; a card re-renders only when its own answer changes. */
export function useIsPeeked(number: number | string | null | undefined): boolean {
  return useRouterState({
    select: (state) => {
      if (number === null || number === undefined) return false
      const peek = peekOf(state.location.search)
      return peek?.kind === 'issue' && peek.id === String(number)
    },
  })
}
