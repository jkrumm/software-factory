import { MoonIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useFormatForDisplay } from '@tanstack/react-hotkeys'
import { useQueryClient } from '@tanstack/react-query'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { NAV } from '@/lib/nav'
import { setThemePreference, type ThemePreference } from '@/lib/theme'

const THEMES: ReadonlyArray<{ preference: ThemePreference; label: string }> = [
  { preference: 'light', label: 'Switch theme: light' },
  { preference: 'dark', label: 'Switch theme: dark' },
  { preference: 'system', label: 'Switch theme: system' },
]

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const format = useFormatForDisplay()
  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Go to a page or run a command"
    >
      <Command>
        <CommandInput placeholder="Type a command" />
        <CommandList>
          <CommandEmpty>No command matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            {NAV.map(({ to, label, icon: Icon, key }) => (
              <CommandItem key={to} value={`Go to ${label}`} onSelect={run(() => void navigate({ to }))}>
                <Icon />
                Go to {label}
                <CommandShortcut>{format(['G', key])}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Theme">
            {THEMES.map(({ preference, label }) => (
              <CommandItem key={preference} value={label} onSelect={run(() => setThemePreference(preference))}>
                <MoonIcon />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Data">
            <CommandItem value="Reload data" onSelect={run(() => void queryClient.invalidateQueries())}>
              <ArrowsClockwiseIcon />
              Reload data
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
