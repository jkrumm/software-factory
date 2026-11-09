import { Accounts } from '@/components/strip/accounts'
import { Counts } from '@/components/strip/counts'
import { Host } from '@/components/strip/host'
import { Live } from '@/components/strip/live'

/**
 * The header strip, one line from 1280 px up and two below: the counts (each a link to Flow filtered to it), one meter
 * per subscription, the host's load, memory and swap, and Live at the right end. Each meter opens a popover with the
 * detail. The shell mounts it in the header and puts the palette button after it.
 */
export function StatusStrip() {
  return (
    <div
      aria-label="Status"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 min-[1280px]:flex-nowrap 2xl:gap-x-4"
    >
      <Counts />
      <Accounts />
      <Host />
      <div className="ml-auto">
        <Live />
      </div>
    </div>
  )
}
