import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useFormatForDisplay, useHotkey, useHotkeys } from '@tanstack/react-hotkeys'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { lazy, Suspense, useState } from 'react'
import { Sidebar, SidebarProvider } from '@/components/sidebar'
import { StatusStrip } from '@/components/status-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { NAV } from '@/lib/nav'
import { useNeeds } from '@/lib/queries'

// cmdk and its dialog load when the palette is first opened, not with the first paint
const CommandPalette = lazy(() => import('@/components/palette').then((m) => ({ default: m.CommandPalette })))

/** Mounts the palette on its first open, so cmdk is fetched then and not with the first paint. */
function PaletteHost({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [mounted, setMounted] = useState(false)
  if (open && !mounted) setMounted(true)
  if (!mounted) return null
  return (
    <Suspense fallback={null}>
      <CommandPalette open={open} onOpenChange={onOpenChange} />
    </Suspense>
  )
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

  useHotkey('Mod+K', () => setPaletteOpen((open) => !open))
  useHotkeys(
    NAV.map(({ to, key }) => ({ hotkey: ['G', key] as const, callback: () => void navigate({ to }) })),
    { enabled: !paletteOpen },
  )

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
            <main className="min-h-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
            <TabBar count={count} />
          </div>
          <PaletteHost open={paletteOpen} onOpenChange={setPaletteOpen} />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  )
}
