import { FactoryIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import { useFormatForDisplay } from '@tanstack/react-hotkeys'
import { Link } from '@tanstack/react-router'
import { createContext, type ReactElement, type ReactNode, use, useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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

const ENTRY =
  'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-muted-foreground outline-none transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-accent aria-pressed:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground motion-reduce:transition-none'

/** One toggle of a page section: a label and the count behind it. `render` returns the link or button that carries the props. */
export function SidebarEntry({
  label,
  count,
  pressed,
  current,
  render,
}: {
  label: string
  count?: number
  pressed?: boolean
  current?: boolean
  render: (props: {
    className: string
    'aria-pressed'?: boolean
    'aria-current'?: 'page'
    children: ReactNode
  }) => ReactElement
}) {
  return render({
    className: ENTRY,
    ...(pressed === undefined ? {} : { 'aria-pressed': pressed }),
    ...(current ? { 'aria-current': 'page' as const } : {}),
    children: (
      <>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count === undefined ? null : <span className="text-xs tabular-nums">{count}</span>}
      </>
    ),
  })
}

/** The logo slot: swap the child for an `<img>` later. */
function Logo() {
  return (
    <span
      data-testid="sidebar-logo"
      className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"
    >
      <FactoryIcon weight="fill" className="size-4" aria-hidden />
    </span>
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
  const link = (
    <Link
      to={item.to}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        ENTRY,
        'relative data-[status=active]:bg-accent data-[status=active]:text-foreground',
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
      {shown === null ? null : prominent ? (
        <Badge
          aria-label={`${shown} ${countLabel}`}
          className={cn(
            'h-4 min-w-4 justify-center px-1 text-[11px] tabular-nums',
            collapsed && 'absolute top-0 right-0',
          )}
        >
          {shown}
        </Badge>
      ) : (
        <span
          aria-label={`${shown} ${countLabel}`}
          className={cn('text-xs tabular-nums', collapsed && 'absolute top-0 right-0.5 text-[10px]')}
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
      </TooltipContent>
    </Tooltip>
  )
}

/** The desktop sidebar: logo, the global nav, then the page's own section. Below `md` the TabBar takes over. */
export function Sidebar({ needs }: { needs: number | null }) {
  const { setSlot, collapsed, toggle } = useSidebar()
  const { data } = useFlow()
  const working = data?.states.working.count ?? null
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
            count={item.to === '/needs-you' ? needs : item.to === '/flow' ? working : null}
            countLabel={item.to === '/flow' ? 'working' : 'waiting'}
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
              className={cn(ENTRY, collapsed && 'justify-center px-0')}
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
