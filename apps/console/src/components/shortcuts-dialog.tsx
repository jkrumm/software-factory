import { useFormatForDisplay } from '@tanstack/react-hotkeys'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SHORTCUT_GROUPS, type ShortcutKeys } from '@/lib/shortcuts'

/** One binding as its keys: a chord is one cap, a sequence one cap per step, in the platform's own symbols. */
function Keys({ keys }: { keys: ShortcutKeys }) {
  const format = useFormatForDisplay()
  const steps = typeof keys === 'string' ? [keys] : keys
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {steps.map((step, i) => (
        <kbd
          key={`${step}-${i}`}
          className="min-w-6 rounded-sm bg-muted px-1.5 py-0.5 text-center font-mono text-xs text-foreground"
        >
          {format(step as never)}
        </kbd>
      ))}
    </span>
  )
}

/** The help overlay: every key the Console binds, by group (`SHORTCUT_GROUPS`). */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="shortcuts">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys work anywhere outside a text field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title} className="flex flex-col gap-1">
              <h3 className="pb-1 text-xs font-medium text-muted-foreground">{group.title}</h3>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <li
                    key={item.label}
                    data-shortcut={typeof item.keys === 'string' ? item.keys : item.keys.join(' ')}
                    className="flex min-h-8 items-center justify-between gap-3 border-b border-border/60 text-[13px] last:border-b-0"
                  >
                    <span className="min-w-0">{item.label}</span>
                    <Keys keys={item.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
