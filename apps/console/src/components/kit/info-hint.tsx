import { InfoIcon } from '@phosphor-icons/react'
import { Popover } from '@base-ui/react/popover'
import { LANGUAGE } from '@/lib/language.gen'
import { cn } from '@/lib/utils'

/** A word that `docs/language.md` defines, lower-cased; a miss is a type error. */
export type InfoWord = keyof typeof LANGUAGE

export interface InfoHintProps {
  /** The domain word, in any capitalisation ("Errand", "held signal"). */
  word: InfoWord | Capitalize<InfoWord>
  className?: string
}

/** A small ⓘ beside a domain word. Its text is the word's definition from `docs/language.md`, generated, never retyped. */
export function InfoHint({ word, className }: InfoHintProps) {
  const key = word.toLowerCase() as InfoWord
  const title = `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        aria-label={`What ${title} means`}
        className={cn(
          'inline-grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:text-foreground',
          className,
        )}
      >
        <InfoIcon className="size-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="isolate z-50">
          <Popover.Popup
            className="max-w-xs rounded-lg bg-popover p-3 text-popover-foreground outline-none"
            style={{ boxShadow: 'var(--vx-shadow-overlay)' }}
          >
            <Popover.Title className="text-[length:var(--vx-text-sm)] font-semibold">{title}</Popover.Title>
            <Popover.Description className="mt-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
              {LANGUAGE[key]}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
