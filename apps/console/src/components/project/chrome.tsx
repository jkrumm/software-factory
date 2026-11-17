import { CaretUpDownIcon, CheckIcon } from '@phosphor-icons/react'
import { Link, useLocation } from '@tanstack/react-router'
import type { ProjectPageModel } from '@software-factory/contract'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ageWords } from '@/lib/age'
import { PROJECT_TABS, useProjectIndex } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { LINK } from './parts'
import { type ProjectScreen, SCREEN_WORDS, ScreenLink } from './tab-link'

/** The screen of the project the address names: the first screen, or the tab it ends in. */
export function screenOf(pathname: string): ProjectScreen {
  const last = pathname.replace(/\/+$/, '').split('/').pop()
  return PROJECT_TABS.find((tab) => tab === last) ?? 'overview'
}

/** Every project the owner may open, one click each, landing on the screen that is open now. The page's former sidebar section of projects. */
function ProjectSwitcher({ name }: { name: string }) {
  const index = useProjectIndex()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const screen = screenOf(pathname)
  const projects = (index.data?.projects ?? []).filter((p) => !p.work || p.name === name)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Switch project"
        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[length:var(--vx-text-sm)] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        Switch
        <CaretUpDownIcon className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" aria-label="Projects">
        <ul className="grid max-h-96 gap-0.5 overflow-y-auto">
          {projects.map((project) => (
            <li key={project.name}>
              <ScreenLink
                name={project.name}
                screen={screen}
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[length:var(--vx-text-sm)] outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50',
                  project.name === name && 'bg-muted font-medium',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.counts.work.running > 0 ? (
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {project.counts.work.running} running
                  </span>
                ) : null}
                {project.name === name ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
              </ScreenLink>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

const TAB =
  'inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 text-[length:var(--vx-text-sm)] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[status=active]:bg-muted data-[status=active]:text-foreground'

/** The tabs: each is an address, so a reload or a shared link lands on it. The counts are the page's own, never another read. */
function ProjectTabs({ name, counts }: { name: string; counts: ProjectPageModel['counts'] }) {
  const open = counts.work.running + counts.work.paused + counts.work.ready + counts.work.held + counts.work.checking
  const tabs: { screen: ProjectScreen; count?: number }[] = [
    { screen: 'overview' },
    { screen: 'work', count: open },
    { screen: 'plan' },
    { screen: 'shipped', count: counts.done7d },
    { screen: 'hygiene' },
    { screen: 'setup' },
  ]
  return (
    <nav aria-label="Project sections" className="mb-6 flex gap-1 overflow-x-auto border-b pb-2">
      {tabs.map(({ screen, count }) => (
        <ScreenLink key={screen} name={name} screen={screen} className={TAB}>
          {SCREEN_WORDS[screen]}
          {count === undefined ? null : (
            <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
          )}
        </ScreenLink>
      ))}
    </nav>
  )
}

/** The project's name with its switcher, where it reads from, the other screens filtered to it, and the tabs. */
export function ProjectChrome({ page, now }: { page: ProjectPageModel; now: number }) {
  const synced = page.syncedAt
    ? `read ${ageWords(Math.max(0, now - Date.parse(page.syncedAt)))}`
    : 'no project.yaml read yet'
  const note = [page.branch ? `Branch ${page.branch}` : null, synced, page.work ? 'a work project' : null]
    .filter(Boolean)
    .join(', ')
  return (
    <>
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{page.name}</h1>
        <ProjectSwitcher name={page.name} />
        <p className="text-sm text-muted-foreground">{note}</p>
        <nav
          aria-label="This project in other screens"
          className="flex flex-wrap gap-x-4 gap-y-1 text-sm min-[40rem]:ml-auto"
        >
          <Link to="/" search={{ project: page.name }} className={LINK}>
            Overview
          </Link>
          <Link to="/chain" search={{ project: page.name }} className={LINK}>
            Chain
          </Link>
          <Link to="/artifacts" search={{ project: page.name }} className={LINK}>
            Artifacts
          </Link>
        </nav>
      </header>
      <ProjectTabs name={page.name} counts={page.counts} />
    </>
  )
}
