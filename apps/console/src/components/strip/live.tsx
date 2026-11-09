import type { ReactNode } from 'react'
import { PopoverTitle } from '@/components/ui/popover'
import { ageWords } from '@/lib/age'
import { useConnection } from '@/lib/connection'
import { useHost } from '@/lib/queries'
import { streamWords, uptimeWords } from '@/lib/strip'
import { cn } from '@/lib/utils'
import { StripPopover } from './strip-popover'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-6 items-center text-muted-foreground">{label}</dt>
      <dd className="flex min-h-6 min-w-0 items-center tabular-nums">{children}</dd>
    </>
  )
}

const none = <span className="text-muted-foreground">-</span>

/** The lamp and the word at the strip's right end; its popover says how the page hears the server. */
export function Live() {
  const connection = useConnection()
  const host = useHost().data
  const { label, offline, live, lastEventAt, newestDataAt, now } = connection
  const age = (at: number) => ageWords(Math.max(0, now - at))
  const [eventLabel, eventAt] = lastEventAt === null ? ['Newest data', newestDataAt] : ['Last event', lastEventAt]
  return (
    <StripPopover
      label={`Connection: ${label}`}
      className="w-80"
      align="end"
      trigger={
        <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn('size-2 rounded-full', offline ? 'bg-destructive' : live ? 'bg-good' : 'bg-warn')}
          />
          {label}
        </span>
      }
    >
      <PopoverTitle>Connection</PopoverTitle>
      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-1">
        <Row label="Stream">{streamWords(connection)}</Row>
        <Row label={eventLabel}>{eventAt > 0 ? age(eventAt) : none}</Row>
        <Row label="Server">{host ? <span className="font-mono">{host.version}</span> : none}</Row>
        <Row label="Uptime">{host ? uptimeWords(host.startedAt, new Date(now)) : none}</Row>
      </dl>
    </StripPopover>
  )
}
