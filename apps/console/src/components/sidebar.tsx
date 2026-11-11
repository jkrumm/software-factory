import { HourglassIcon, SidebarSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useFormatForDisplay } from '@tanstack/react-hotkeys'
import { Link } from '@tanstack/react-router'
import { createContext, type ReactElement, type ReactNode, use, useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { InfoHint, type InfoWord } from '@/components/kit'
import { Logo } from '@/components/logo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { boardOf, countsOf, type OpenSplit, openCount } from '@/lib/flow'
import { NAV, type NavItem } from '@/lib/nav'
import { useFlow } from '@/lib/queries'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'console-sidebar'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

interface SidebarState {
  /** the element the page sections portal into; null until the sidebar has mounted */
  slot: HTMLElement | null
  setSlot: (element: HTMLElement | null) => void
  collapsed: boolean
  toggle: () => void
}

const SidebarContext = createContext<SidebarState | null>(null)

function useSidebar(): SidebarState {
  const state = use(SidebarContext)
  if (!state) throw new Error('useSidebar outside SidebarProvider')
  return state
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = useCallback(() => {
    setCollapsed((was) => {
      try {
        localStorage.setItem(STORAGE_KEY, was ? 'expanded' : 'collapsed')
      } catch {
        // storage unavailable: the choice lasts for this visit
      }
      return !was
    })
  }, [])
  const value = useMemo(() => ({ slot, setSlot, collapsed, toggle }), [slot, collapsed, toggle])
  return <SidebarContext value={value}>{children}</SidebarContext>
}

/**
 * The page's own section of the sidebar: a page renders this and it appears under the hairline, then leaves with the
 * page. Hidden when the sidebar is collapsed or below `md`.
 */
export function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  const { slot } = useSidebar()
  if (!slot) return null
  return createPortal(
    <div role="group" aria-label={title} className="flex flex-col gap-0.5">
      <p aria-hidden className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {title}
      </p>
      {children}
    </div>,
    slot,
  )
}

const ROW =
  'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-muted-foreground outline-none transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none'
/** A toggle row: no filled block, a selected one gets a leading dot and heavier text. */
const ENTRY = `${ROW} aria-pressed:font-semibold aria-pressed:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground`

/** Whether the sidebar is collapsed to icons. */
export const useSidebarCollapsed = (): boolean => useSidebar().collapsed

export interface FilterChip {
  key: string
  label: string
  /** returns the link that clears this filter */
  render: (props: { className: string; 'aria-label': string; children: ReactNode }) => ReactElement
}

/** The page's active filters as removable chips, for md+ while the sidebar is collapsed (its section is hidden then). */
export function ActiveFilters({ chips }: { chips: FilterChip[] }) {
  const collapsed = useSidebarCollapsed()
  if (!collapsed || chips.length === 0) return null
  return (
    <div aria-label="Active filters" role="group" className="mb-4 hidden flex-wrap gap-2 md:flex">
      {chips.map((chip) =>
        chip.render({
          className:
            'inline-flex h-6 items-center gap-1 rounded-full bg-secondary px-2.5 text-xs text-secondary-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
          'aria-label': `Remove filter ${chip.label}`,
          children: (
            <>
              {chip.label}
              <XIcon className="size-3" aria-hidden />
            </>
          ),
        }),
      )}
    </div>
  )
}

/**
 * What runs and what waits, as two small figures: a lit lamp and the running count, an hourglass and the pending count.
 * A zero keeps its slot empty so the figures of every row line up; with both at zero nothing shows.
 */
function OpenFigures({ running, pending }: OpenSplit) {
  if (running + pending === 0) return null
  const words = [running ? `${running} working` : null, pending ? `${pending} waiting` : null]
    .filter(Boolean)
    .join(', ')
  return (
    <span
      aria-label={words}
      title={`${words}${pending ? ' (waiting, queued or settling)' : ''}`}
      className="flex shrink-0 items-center gap-2 text-xs font-normal tabular-nums"
    >
      <span aria-hidden className="flex w-8 shrink-0 items-center gap-1">
        {running ? (
          <>
            <span className="mx-[3px] size-1.5 shrink-0 rounded-full bg-good" />
            <span className="w-[2ch] text-right text-foreground">{running}</span>
          </>
        ) : null}
      </span>
      <span aria-hidden className="flex w-8 shrink-0 items-center gap-1">
        {pending ? (
          <>
            <HourglassIcon className="size-3 shrink-0" />
            <span className="w-[2ch] text-right">{pending}</span>
          </>
        ) : null}
      </span>
    </span>
  )
}

/**
 * One toggle of a page section: a label and the count behind it, or `open` for a split of what runs and what waits.
 * `render` returns the link or button that carries the props.
 */
export function SidebarEntry({
  label,
  count,
  open,
  pressed,
  current,
  hint,
  render,
}: {
  label: string
  count?: number
  /** The open Issues behind this row, split into running and pending; a row with none shows no figure. */
  open?: OpenSplit
  pressed?: boolean
  current?: boolean
  /** A domain word to define: its InfoHint sits beside the row, never inside the toggle. */
  hint?: InfoWord
  render: (props: {
    className: string
    'aria-pressed'?: boolean
    'aria-current'?: 'page'
    children: ReactNode
  }) => ReactElement
}) {
  const row = render({
    className: ENTRY,
    ...(pressed === undefined ? {} : { 'aria-pressed': pressed }),
    ...(current ? { 'aria-current': 'page' as const } : {}),
    children: (
      <>
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-primary opacity-0 group-aria-pressed:opacity-100 group-aria-[current=page]:opacity-100"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count === undefined ? null : <span className="text-xs font-normal tabular-nums">{count}</span>}
        {open ? <OpenFigures {...open} /> : null}
      </>
    ),
  })
  if (!hint) return row
  return (
    <div className="flex items-center gap-0.5">
      <div className="flex min-w-0 flex-1">{row}</div>
      <InfoHint word={hint} />
    </div>
  )
}

function NavEntry({
  item,
  count,
  countLabel,
  collapsed,
  prominent,
}: {
  item: NavItem
  count: number | null
  countLabel: string
  collapsed: boolean
  prominent?: boolean
}) {
  const format = useFormatForDisplay()
  const chord = format(['G', item.key])
  const Icon = item.icon
  const shown = count ? count : null
  const countWords = shown === null ? null : `${shown} ${countLabel}`
  const link = (
    <Link
      to={item.to}
      aria-label={collapsed ? [item.label, countWords].filter(Boolean).join(', ') : undefined}
      className={cn(
        ROW,
        'relative data-[status=active]:bg-accent data-[status=active]:text-[color:var(--vx-accent)]',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4 shrink-0" />
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <kbd className="hidden font-mono text-[11px] font-normal text-muted-foreground group-hover:inline group-focus-visible:inline">
            {chord}
          </kbd>
        </>
      )}
      {shown === null ? null : collapsed ? (
        <span
          aria-hidden
          className={cn(
            'absolute top-1 right-2 size-1.5 rounded-full',
            prominent ? 'bg-primary' : 'bg-muted-foreground',
          )}
        />
      ) : (
        <span
          aria-label={countWords ?? undefined}
          className={cn('text-xs font-normal tabular-nums', prominent && 'font-semibold text-foreground')}
        >
          {shown}
        </span>
      )}
    </Link>
  )
  if (!collapsed) return link
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">
        {item.label} {chord}
        {countWords ? `, ${countWords}` : ''}
      </TooltipContent>
    </Tooltip>
  )
}

/** The desktop sidebar: logo, the global nav, then the page's own section. Below `md` the TabBar takes over. */
export function Sidebar({ needs }: { needs: number | null }) {
  const { setSlot, collapsed, toggle } = useSidebar()
  const { data } = useFlow()
  const open = data ? openCount(countsOf(boardOf(data))) : null
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        'hidden shrink-0 flex-col gap-3 border-r bg-card p-2 pt-[calc(0.5rem+env(safe-area-inset-top))] transition-[width] duration-150 motion-reduce:transition-none md:flex',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div className={cn('flex h-8 items-center gap-2 px-1', collapsed && 'justify-center px-0')}>
        <Logo />
        {collapsed ? null : <span className="font-heading text-[15px] font-semibold tracking-tight">Factory</span>}
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavEntry
            key={item.to}
            item={item}
            collapsed={collapsed}
            count={item.to === '/needs-you' ? needs : item.to === '/flow' ? open : null}
            countLabel={item.to === '/flow' ? 'open' : 'waiting'}
            prominent={item.to === '/needs-you'}
          />
        ))}
      </nav>
      <div
        ref={setSlot}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t pt-3 empty:hidden',
          collapsed && 'hidden',
        )}
      />
      <div className="mt-auto" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              onClick={toggle}
              className={cn(ROW, collapsed && 'justify-center px-0')}
            />
          }
        >
          <SidebarSimpleIcon className="size-4 shrink-0" />
          {collapsed ? null : <span>Collapse</span>}
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </aside>
  )
}
