import { FactoryIcon } from '@phosphor-icons/react'

/**
 * The sidebar's logo slot: the one place the Factory's mark is rendered. A new mark replaces the body of this component
 * and nothing else (the sidebar only places `<Logo />`; `tests/e2e/frame-sidebar.e2e.ts` finds it by `sidebar-logo`).
 */
export function Logo() {
  return (
    <span
      data-testid="sidebar-logo"
      className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"
    >
      <FactoryIcon weight="fill" className="size-4" aria-hidden />
    </span>
  )
}
