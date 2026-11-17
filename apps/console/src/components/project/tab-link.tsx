import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { type ProjectTab, prefetchProjectOverview, prefetchProjectTab } from '@/lib/queries'

export type ProjectScreen = 'overview' | ProjectTab

export const SCREEN_WORDS: Record<ProjectScreen, string> = {
  overview: 'Overview',
  work: 'Work',
  plan: 'Plan',
  shipped: 'Shipped',
  hygiene: 'Hygiene',
  setup: 'Setup',
}

/** A link to one screen of a project's page: the first screen is the project's own address, a tab is `/projects/<name>/<tab>`. Hover and focus warm its data. */
export function ScreenLink({
  name,
  screen,
  className,
  children,
  onClick,
  exactActive,
}: {
  name: string
  screen: ProjectScreen
  className?: string
  children: ReactNode
  onClick?: () => void
  /** `aria-current` only on the exact address (the first screen is a prefix of every tab) */
  exactActive?: boolean
}) {
  const warm = () => (screen === 'overview' ? prefetchProjectOverview(name) : prefetchProjectTab(name, screen))
  const shared = {
    params: { name },
    className,
    onClick,
    onMouseEnter: warm,
    onFocus: warm,
    activeOptions: { exact: exactActive ?? true },
  }
  switch (screen) {
    case 'overview':
      return (
        <Link to="/projects/$name" {...shared}>
          {children}
        </Link>
      )
    case 'work':
      return (
        <Link to="/projects/$name/work" {...shared}>
          {children}
        </Link>
      )
    case 'plan':
      return (
        <Link to="/projects/$name/plan" {...shared}>
          {children}
        </Link>
      )
    case 'shipped':
      return (
        <Link to="/projects/$name/shipped" {...shared}>
          {children}
        </Link>
      )
    case 'hygiene':
      return (
        <Link to="/projects/$name/hygiene" {...shared}>
          {children}
        </Link>
      )
    case 'setup':
      return (
        <Link to="/projects/$name/setup" {...shared}>
          {children}
        </Link>
      )
  }
}
