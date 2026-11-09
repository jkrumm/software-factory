'use client'

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { cn } from '@/lib/utils'

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('min-w-0', className)} {...props} />
}

/** Scrolls inside itself, so a phone never scrolls the page sideways. */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('flex gap-1 overflow-x-auto border-b pb-2', className)}
      {...props}
    />
  )
}

/** The active tab is a surface step (`bg-muted`), no underline. */
function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        'inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 text-[length:var(--vx-text-sm)] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-active:bg-muted data-active:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn('pt-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsPanel, TabsTab }
