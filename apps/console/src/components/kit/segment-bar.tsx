import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChartTooltip } from './chart-frame'
import { mix, TONE_MARK, type Tone } from './tone'

export interface Segment {
  key: string
  label: string
  value: number
  /** The state's tone from the caller's explicit map (`LOZENGE_TONES`), the same tone the state has everywhere. */
  tone: Tone
  /** The tone at half strength: the second part of a tone in one bar (Held beside Ready, Checking beside Running) */
  faint?: boolean
}

export interface SegmentBarProps {
  /** The parts in order from the left; a zero part draws nothing and stays in the tooltip. */
  segments: Segment[]
  /** The value of a full bar; default the sum, so the bar always fills. A shared scale makes rows comparable. */
  scale?: number
  /** What the bar shows, for the accessible name ("Open Issues of argo"). */
  name: string
  className?: string
}

/** A neutral part is a step of ink, as a graphite meter is: the hairline step vanishes on the track. */
const markOf = (tone: Tone, faint = false): string =>
  tone === 'neutral' ? mix('var(--vx-ink2)', faint ? 22 : 45) : faint ? mix(TONE_MARK[tone], 45) : TONE_MARK[tone]

/**
 * A thin horizontal bar split into parts, each in its state's tone, with a 1 px surface gap between parts, on a faint
 * track. Hover or focus shows every part with its count; the accessible name lists them. No animation.
 */
export function SegmentBar({ segments, scale, name, className }: SegmentBarProps) {
  const [shown, setShown] = useState(false)
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  const full = Math.max(scale ?? total, total, 1)
  const words = segments.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(', ')
  const parts = segments.filter((s) => s.value > 0)
  return (
    <div
      role="img"
      aria-label={`${name}: ${words}`}
      className={cn('relative flex h-6 w-full min-w-0 items-center', className)}
      onPointerEnter={() => setShown(true)}
      onPointerLeave={() => setShown(false)}
    >
      <div
        aria-hidden="true"
        className="flex h-2 w-full gap-px overflow-hidden rounded-full"
        style={{ background: mix('var(--vx-ink2)', 10) }}
      >
        {parts.map((s) => (
          <div
            key={s.key}
            data-segment={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(s.value / full) * 100}%`, minWidth: 3, background: markOf(s.tone, s.faint) }}
          />
        ))}
      </div>
      {shown ? (
        <ChartTooltip
          row={{ value: `${total} open`, label: name, lines: segments.map((s) => `${s.label} ${s.value}`) }}
          left="50%"
        />
      ) : null}
    </div>
  )
}
