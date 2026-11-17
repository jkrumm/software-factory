import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useFormatForDisplay, useHotkey, useHotkeys } from '@tanstack/react-hotkeys'
import { Link, Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Notices } from '@/components/notices'
import { PeekHost } from '@/components/peek/host'
import { useListKeys } from '@/components/shortcuts'
import { Sidebar, SidebarProvider } from '@/components/sidebar'
import { StatusStrip } from '@/components/status-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { NAV, NAV_GROUPS } from '@/lib/nav'
import { peekOf } from '@/lib/peek'
import { prefetchPalette, useNeeds } from '@/lib/queries'
import { useRecordVisits } from '@/lib/recent'
import { parentOf } from '@/lib/shortcuts'

const loadPalette = () => import('@/components/palette').then((m) => ({ default: m.CommandPalette }))
// cmdk and its dialog are a chunk of their own; it is fetched on idle after the first paint (or on hover), not with it
const CommandPalette = lazy(loadPalette)
// the help overlay is fetched the first time `?` is pressed
const ShortcutsDialog = lazy(() =>
  import('@/components/shortcuts-dialog').then((m) => ({ default: m.ShortcutsDialog })),
)

/** Another popup (a popover, the palette, a menu) is open: Escape is its. */
const OTHER_POPUP = '[role="dialog"][data-open], [role="menu"], [role="listbox"]'

/**
 * `/` takes the focus to the page's own filter, the selected toggle of its sidebar section (or its first); a page with no
 * section on screen has no filter, and `/` searches instead. Returns whether it found one.
 */
function focusPageFilter(): boolean {
  const section = document.querySelector<HTMLElement>('[data-page-section]')
  if (!section || section.getClientRects().length === 0) return false
  const target =
    section.querySelector<HTMLElement>('[aria-pressed="true"], [aria-current="page"]') ??
    section.querySelector<HTMLElement>('a, button')
  if (!target) return false
  target.focus()
  return true
}

/** Mounts the palette once it is wanted: its chunk is loaded (idle, hover) or it was opened. Mounted closed it already holds its data. */
function PaletteHost({
  open,
  preloaded,
  onOpenChange,
}: {
  open: boolean
  preloaded: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [mounted, setMounted] = useState(false)
  if ((open || preloaded) && !mounted) setMounted(true)
  if (!mounted) return null
  return (
    <Suspense fallback={null}>
      <CommandPalette open={open} onOpenChange={onOpenChange} />
    </Suspense>
  )
}

/** The palette's 550 KB lists wait this long after the page is idle, so they never share the first seconds with what the screen shows. */
const PALETTE_PREFETCH_DELAY_MS = 4000

/** Fetches the palette chunk when the browser is idle after the first paint (its lists a few seconds later); `preload` does both at once (hover, focus). */
function usePalettePreload(): { preloaded: boolean; preload: () => void } {
  const [preloaded, setPreloaded] = useState(false)
  const load = (prefetchAfterMs: number) =>
    void loadPalette().then(() => {
      setPreloaded(true)
      setTimeout(prefetchPalette, prefetchAfterMs)
    })
  const preload = () => load(0)
  useEffect(() => {
    const idle = () => load(PALETTE_PREFETCH_DELAY_MS)
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(idle, { timeout: 2000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(idle, 200)
    return () => clearTimeout(id)
  }, [])
  return { preloaded, preload }
}

/** The open needs, summed over the kinds of the needs model; null until the model has loaded. */
function useNeedsCount(): number | null {
  const { data } = useNeeds()
  if (!data) return null
  return Object.values(data.counts).reduce((sum, count) => sum + count, 0)
}

function TabBar({ count }: { count: number | null }) {
  return (
    <nav aria-label="Main" className="flex shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      {NAV_GROUPS[0].items.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: to === '/', includeSearch: false }}
          className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground data-[status=active]:text-foreground data-[status=active]:shadow-[inset_0_3px_0_var(--color-primary)]"
        >
          <Icon className="size-6" />
          {label}
          {to === '/needs-you' && count ? (
            <Badge
              className="absolute top-1.5 left-1/2 ml-2 h-4 min-w-4 justify-center px-1"
              aria-label={`${count} to answer`}
            >
              {count}
            </Badge>
          ) : null}
        </Link>
      ))}
    </nav>
  )
}

export function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const navigate = useNavigate()
  const count = useNeedsCount()
  const format = useFormatForDisplay()
  const { preloaded, preload } = usePalettePreload()
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpMounted, setHelpMounted] = useState(false)
  const router = useRouter()
  const location = useRouterState({ select: (state) => state.location })
  const peekOpen = peekOf(location.search) !== null
  const parent = parentOf(location.pathname)
  const free = !paletteOpen && !helpOpen
  useRecordVisits()

  useHotkey('Mod+K', () => setPaletteOpen((open) => !open))
  useHotkey(
    '?',
    () => {
      setHelpMounted(true)
      setHelpOpen((open) => !open)
    },
    { enabled: !paletteOpen },
  )
  useHotkey(
    '/',
    () => {
      if (!focusPageFilter()) setPaletteOpen(true)
    },
    { enabled: free },
  )
  // Escape on a page of one thing goes back (or to its list); an open panel, popup or field keeps its own Escape
  useHotkey(
    'Escape',
    () => {
      if (document.querySelector(OTHER_POPUP) || !parent) return
      if (router.history.canGoBack()) router.history.back()
      else void navigate({ to: parent })
    },
    { enabled: free && !peekOpen && parent !== null, ignoreInputs: true, ignoreDefaultPrevented: true },
  )
  useHotkeys(
    NAV.map(({ to, key }) => ({ hotkey: ['G', key] as const, callback: () => void navigate({ to }) })),
    { enabled: free },
  )
  useListKeys(free)

  return (
    <TooltipProvider>
      <SidebarProvider>
        <div className="flex h-dvh w-full">
          <Sidebar needs={count} />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center gap-3 border-b px-4 pt-[env(safe-area-inset-top)] md:min-h-12 md:px-8">
              <div className="min-w-0 flex-1">
                <StatusStrip
                  trailing={
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0 md:size-8"
                            aria-label="Open command palette"
                            onPointerEnter={preload}
                            onFocus={preload}
                            onClick={() => setPaletteOpen(true)}
                          />
                        }
                      >
                        <MagnifyingGlassIcon className="size-5" />
                      </TooltipTrigger>
                      <TooltipContent>Command palette {format('Mod+K')}</TooltipContent>
                    </Tooltip>
                  }
                />
              </div>
            </header>
            <Notices />
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* `relative` makes `main` the containing block of an absolute descendant (a chart's sr-only table), so its overflow clips it; otherwise the box sits past the viewport and the document scrolls. */}
              <main className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                <Outlet />
              </main>
              <PeekHost />
            </div>
            <TabBar count={count} />
          </div>
          <PaletteHost open={paletteOpen} preloaded={preloaded} onOpenChange={setPaletteOpen} />
          {helpMounted ? (
            <Suspense fallback={null}>
              <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
            </Suspense>
          ) : null}
        </div>
      </SidebarProvider>
    </TooltipProvider>
  )
}
