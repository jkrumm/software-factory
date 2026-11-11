import { createRootRoute } from '@tanstack/react-router'
import { Shell } from '@/components/shell'
import { peekOf, type PeekSearch, peekSearch } from '@/lib/peek'

export const Route = createRootRoute({
  /** `?peek=` opens an Issue or an artifact in the panel over any page (`lib/peek.ts`). */
  validateSearch: (search: Record<string, unknown>): PeekSearch => {
    const peek = peekSearch(peekOf(search))
    return Object.fromEntries(Object.entries(peek).filter(([, value]) => value !== undefined))
  },
  component: Shell,
})
