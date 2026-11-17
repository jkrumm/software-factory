import type { ReactNode } from 'react'
import { PopoverTitle } from '@/components/ui/popover'
import { ageWords } from '@/lib/age'
import { BUILD_ID } from '@/lib/build'
import { useConnection } from '@/lib/connection'
import { buildTime } from '@/lib/freshness'
import { useHost } from '@/lib/queries'
import { streamWords, uptimeWords } from '@/lib/strip'
import { useUpdatePhase } from '@/lib/update'
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
  const { label, offline, live, lastEventAt, newestDataAt, now, stale } = connection
  const phase = useUpdatePhase()
  const age = (at: number) => ageWords(Math.max(0, now - at))
  const builtAt = buildTime(BUILD_ID)
  const [eventLabel, eventAt] = lastEventAt === null ? ['Newest data', newestDataAt] : ['Last event', lastEventAt]
  return (
    <StripPopover
      label={`Connection: ${label}`}
      className="w-80"
      align="end"
      trigger={
        <span role="status" aria-live="polite" data-build={BUILD_ID} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              'size-2 rounded-full',
              offline ? 'bg-destructive' : live && stale.length === 0 ? 'bg-good' : 'bg-warn',
            )}
          />
          {label}
          {stale.length > 0 ? <span className="text-muted-foreground">{`${stale.length} stale`}</span> : null}
          {phase === 'current' ? null : <span className="text-muted-foreground">updating</span>}
          <span className="hidden text-muted-foreground 2xl:inline" data-testid="build-age">
            {builtAt === null ? `build ${BUILD_ID}` : `build ${age(builtAt)}`}
          </span>
        </span>
      }
    >
      <PopoverTitle>Connection</PopoverTitle>
      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-1">
        <Row label="Stream">{streamWords(connection)}</Row>
        <Row label={eventLabel}>{eventAt > 0 ? age(eventAt) : none}</Row>
        <Row label="Server">{host ? <span className="font-mono">{host.version}</span> : none}</Row>
        <Row label="Uptime">{host ? uptimeWords(host.startedAt, new Date(now)) : none}</Row>
        <Row label="Build">
          <span className="font-mono">{BUILD_ID}</span>
          {builtAt === null ? null : <span className="ml-2 text-muted-foreground">{age(builtAt)}</span>}
        </Row>
        <Row label="Update">
          {phase === 'current' ? 'Up to date' : phase === 'updating' ? 'Updating' : 'Not applied'}
        </Row>
        <Row label="Stale reads">
          {stale.length === 0 ? (
            'None'
          ) : (
            <span className="flex flex-col">
              {stale.map(({ label: read, ageMs }) => (
                <span key={read}>
                  {read} <span className="text-muted-foreground">{ageWords(ageMs)}</span>
                </span>
              ))}
            </span>
          )}
        </Row>
      </dl>
    </StripPopover>
  )
}
