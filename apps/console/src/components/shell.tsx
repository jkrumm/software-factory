import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useFormatForDisplay, useHotkey, useHotkeys } from '@tanstack/react-hotkeys'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { ConnectionChip } from '@/components/connection-chip'
import { CommandPalette } from '@/components/palette'
import { StatusStrip } from '@/components/status-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { NAV } from '@/lib/nav'
import { useNeeds } from '@/lib/queries'

/** The open needs, summed over the kinds of the needs model; null until the model has loaded. */
function useNeedsCount(): number | null {
  const { data } = useNeeds()
  if (!data) return null
  return Object.values(data.counts).reduce((sum, count) => sum + count, 0)
}

function CountBadge({ count }: { count: number | null }) {
  if (!count) return null
  return (
    <Badge className="ml-auto min-w-5 justify-center" aria-label={`${count} waiting`}>
      {count}
    </Badge>
  )
}

function Rail({ count }: { count: number | null }) {
  return (
    <nav
      aria-label="Main"
      className="hidden w-56 shrink-0 flex-col gap-1 border-r bg-card p-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:flex"
    >
      {NAV.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground data-[status=active]:shadow-[inset_3px_0_0_var(--color-primary)]"
        >
          <Icon className="size-5" />
          {label}
          {to === '/needs-you' ? <CountBadge count={count} /> : null}
        </Link>
      ))}
    </nav>
  )
}

function TabBar({ count }: { count: number | null }) {
  return (
    <nav aria-label="Main" className="flex shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      {NAV.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground data-[status=active]:text-foreground data-[status=active]:shadow-[inset_0_3px_0_var(--color-primary)]"
        >
          <Icon className="size-6" />
          {label}
          {to === '/needs-you' && count ? (
            <Badge
              className="absolute top-1.5 left-1/2 ml-2 h-4 min-w-4 justify-center px-1"
              aria-label={`${count} waiting`}
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
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const title = NAV.find((item) => item.to === pathname)?.label ?? 'Software Factory'

  useHotkey('Mod+K', () => setPaletteOpen((open) => !open))
  useHotkeys(
    NAV.map(({ to, key }) => ({ hotkey: ['G', key] as const, callback: () => void navigate({ to }) })),
    { enabled: !paletteOpen },
  )

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full">
        <Rail count={count} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b px-4 pt-[env(safe-area-inset-top)] md:px-8">
            <div className="flex h-12 w-full items-center gap-3">
              <p className="font-heading text-sm font-semibold">{title}</p>
              <div className="ml-auto flex items-center gap-2">
                <ConnectionChip />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 md:size-8"
                        aria-label="Open command palette"
                        onClick={() => setPaletteOpen(true)}
                      />
                    }
                  >
                    <MagnifyingGlassIcon className="size-5" />
                  </TooltipTrigger>
                  <TooltipContent>Command palette {format('Mod+K')}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </header>
          <StatusStrip />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
          <TabBar count={count} />
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </TooltipProvider>
  )
}
