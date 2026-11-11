import { ArrowSquareOutIcon, XIcon } from '@phosphor-icons/react'
import { type ReactElement, type ReactNode, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** How the peek renders its "Open full page" link: pass a router link (`(p) => <Link to="/issues/$id" {...p} />`). */
export type PeekPageLink = (props: { className: string; children: ReactNode; 'data-peek': 'off' }) => ReactElement

export interface PeekProps {
  /** The panel's accessible name: what is shown ("Issue 12"). */
  label: string
  /** A short mono tag in the header ("Issue 12"). */
  tag: string
  /** The full page of what is shown. */
  page: PeekPageLink
  /** Escape, the close button, and back: the caller decides how the address changes. */
  onClose: () => void
  children: ReactNode
  className?: string
}

/** The overlay shadow plus two more, to the left and upward: on a light canvas (and under the header strip on a phone) the panel's edge would otherwise be only its fill. */
const PANEL_SHADOW =
  'var(--vx-shadow-overlay), -12px 0 32px -12px color-mix(in oklab, var(--color-foreground) 24%, transparent), 0 -12px 24px -12px color-mix(in oklab, var(--color-foreground) 18%, transparent)'

/** The classes of every link and button that leave the peek for the full page: the host's click handler skips `data-peek="off"`. */
const HEADER_BUTTON =
  'inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50'

/**
 * A right-side panel over the page it was opened from: the page underneath stays mounted, so its scroll, filters and
 * selection are where they were when the panel closes. It is not modal (nothing behind it is inert and there is no scrim),
 * so another card can be clicked to swap what the panel shows. It fills its positioned parent on a phone and takes the
 * right part of it from `md`. It is a surface step with the overlay shadow, never a border. Focus moves in when it opens
 * and back to what opened it when it closes; Escape is the caller's (it must know about popovers and fields).
 */
export function Peek({ label, tag, page, onClose, children, className }: PeekProps) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const opener = document.activeElement
    panel.current?.focus({ preventScroll: true })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <aside
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      data-peek-panel=""
      className={cn(
        'absolute inset-y-0 right-0 z-30 flex w-full min-w-0 flex-col bg-popover text-popover-foreground outline-none',
        'duration-150 animate-in fade-in-0 slide-in-from-right-8 motion-reduce:animate-none md:w-[min(52rem,calc(100%-3rem),max(38rem,60%))] md:rounded-l-xl',
        className,
      )}
      style={{ boxShadow: PANEL_SHADOW }}
    >
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <span className="font-mono text-xs text-muted-foreground">{tag}</span>
        <div className="ml-auto flex items-center gap-1">
          {page({
            'data-peek': 'off',
            className: HEADER_BUTTON,
            children: (
              <>
                <ArrowSquareOutIcon aria-hidden="true" className="size-3.5" />
                Open full page
              </>
            ),
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  onClick={onClose}
                  className="text-muted-foreground"
                />
              }
            >
              <XIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-peek-body="">
        {children}
      </div>
    </aside>
  )
}
