import { lazy, Suspense } from 'react'
import { MeterBar } from '@/components/kit/meter'
import { Skeleton } from '@/components/kit/skeleton'
import { useHost, useMachine } from '@/lib/queries'
import { hostMeters } from '@/lib/strip'
import { StripPopover } from './strip-popover'

/** The charts are drawn only when the popover opens: the strip's first paint stays light. */
const HostDetail = lazy(() => import('./host-detail'))

/** Load, memory and swap as three small bars in one trigger; the popover is the same whichever the owner points at. */
export function Host() {
  const machine = useMachine().data
  const host = useHost().data
  const newest = host?.samples[host.samples.length - 1]
  if (!machine && !host) return null
  return (
    <StripPopover
      label="Host: load, memory and swap"
      className="w-[28rem]"
      triggerClassName="gap-3"
      trigger={hostMeters(machine, newest).map(({ key, label, fill, text, warn }) => (
        <span key={key} className="inline-flex items-center gap-1.5" data-host={key}>
          {label}
          <span className="w-8 2xl:w-12">
            <MeterBar value={fill ?? 0} tone={warn ? 'warn' : 'accent'} />
          </span>
          <span className="min-w-[3ch] text-right">{text}</span>
        </span>
      ))}
    >
      <Suspense fallback={<Skeleton height={384} />}>
        <HostDetail />
      </Suspense>
    </StripPopover>
  )
}
