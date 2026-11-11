import type { ReactNode } from 'react'
import { Accounts } from '@/components/strip/accounts'
import { Counts } from '@/components/strip/counts'
import { Host } from '@/components/strip/host'
import { Live } from '@/components/strip/live'

/**
 * The header strip. From 1280 px up it is one line: the counts, one meter per subscription, the host's load, memory and
 * swap, then Live and `trailing` at the right end. Below, it is two: the counts with Live and `trailing` pinned to the
 * first, and the meters on a second that scrolls sideways if it must (no wrap, no scrollbar). Each meter opens a
 * popover with the detail.
 */
export function StatusStrip({ trailing }: { trailing?: ReactNode }) {
  return (
    <div
      aria-label="Status"
      className="flex min-w-0 flex-wrap items-center gap-x-2 py-1 md:py-0 min-[1280px]:flex-nowrap 2xl:gap-x-4"
    >
      <Counts />
      <div className="no-scrollbar order-3 flex min-h-7 min-w-0 basis-full items-center gap-x-2 overflow-x-auto min-[1280px]:order-2 min-[1280px]:min-h-0 min-[1280px]:basis-auto min-[1280px]:overflow-visible 2xl:gap-x-4">
        <Accounts />
        <Host />
      </div>
      <div className="order-2 ml-auto flex shrink-0 items-center gap-1 min-[1280px]:order-3">
        <Live />
        {trailing}
      </div>
    </div>
  )
}
