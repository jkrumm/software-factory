'use client'

import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** The surface step above the page and the faint overlay shadow; never a border for depth. Viewport-bounded and collision-aware. */
function PopoverContent({
  className,
  side = 'bottom',
  sideOffset = 8,
  align = 'start',
  alignOffset = 0,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-1rem)] origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-3 text-[length:var(--vx-text-sm)] text-popover-foreground outline-none',
            className,
          )}
          style={{ boxShadow: 'var(--vx-shadow-overlay)' }}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn('font-heading text-[length:var(--vx-text-sm)] font-semibold', className)}
      {...props}
    />
  )
}

export { Popover, PopoverContent, PopoverTitle, PopoverTrigger }
