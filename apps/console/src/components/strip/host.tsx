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
      className="w-[34rem]"
      triggerClassName="gap-2 min-[1280px]:gap-4"
      trigger={hostMeters(machine, newest).map(({ key, label, fill, text, tone }) => (
        <span key={key} className="inline-flex items-center gap-1.5" data-host={key}>
          {label}
          <span className="w-6 min-[1280px]:w-8 2xl:w-12">
            <MeterBar value={fill ?? 0} tone={tone} track="surface" />
          </span>
          <span>{text}</span>
        </span>
      ))}
    >
      <Suspense fallback={<Skeleton height={384} />}>
        <HostDetail />
      </Suspense>
    </StripPopover>
  )
}
