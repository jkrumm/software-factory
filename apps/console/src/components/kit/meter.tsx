import { useState } from 'react'
import { ChartTooltip } from './chart-frame'
import { mix, TONE_MARK, type Tone } from './tone'
import { cn } from '@/lib/utils'

export interface MeterProps {
  /** 0 to 1. */
  value: number
  /** Text beside the bar ("Weekly window"). */
  label?: string
  /** The accessible name when there is no visible label. */
  name?: string
  /** The value as words; default the percentage. */
  valueText?: string
  /** Whether the bar shows its value in a tooltip on hover and focus; off where the value is written beside it. */
  tooltip?: boolean
  /** The track of the bar, see `MeterBarProps`. */
  track?: 'tint' | 'surface'
  /** Overrides the tone the value picks (`meterTone`): the strip warns at 90 %, not at 70. */
  tone?: Tone
  className?: string
}

export interface MeterBarProps {
  /** 0 to 1. */
  value: number
  tone: Tone
  /** `tint` is the fill's colour at 18 %; `surface` is the border step, for a bar on the chrome or a popover. */
  track?: 'tint' | 'surface'
  className?: string
}

/** A fill is at least 2 px wide when there is any, so 3 % is still seen. */
const fill = (value: number): string => {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped > 0 ? `max(2px, ${clamped * 100}%)` : '0'
}

/** The bar alone, for a place that carries its own label and name: a track at 18 % of the fill's colour. Decorative. */
export function MeterBar({ value, tone, track = 'tint', className }: MeterBarProps) {
  const mark = TONE_MARK[tone]
  return (
    <div
      aria-hidden="true"
      className={cn('h-1.5 w-full overflow-hidden rounded-full', className)}
      style={{ background: track === 'surface' ? 'var(--vx-surface-border)' : mix(mark, 18) }}
    >
      <div className="h-full rounded-full" style={{ width: fill(value), background: mark }} />
    </div>
  )
}

/** Accent below 70 %, warn from 70 %, bad from 90 %. */
export function meterTone(value: number): Tone {
  if (value >= 0.9) return 'bad'
  if (value >= 0.7) return 'warn'
  return 'accent'
}

/** A thin rounded bar, its track a lighter step of the fill's own hue. Shows its value on hover and focus. */
export function Meter({ value, label, name, valueText, tone, tooltip = true, track, className }: MeterProps) {
  const [shown, setShown] = useState(false)
  const clamped = Math.max(0, Math.min(1, value))
  const text = valueText ?? `${Math.round(clamped * 100)} %`
  return (
    <div className={cn('flex items-center gap-3 text-[length:var(--vx-text-sm)]', className)}>
      {label ? <span className="w-28 shrink-0 text-muted-foreground">{label}</span> : null}
      <div
        role="meter"
        tabIndex={0}
        aria-label={label ?? name ?? 'Meter'}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={clamped}
        aria-valuetext={text}
        className="relative flex h-6 min-w-16 flex-1 items-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onPointerEnter={() => setShown(true)}
        onPointerLeave={() => setShown(false)}
        onFocus={() => setShown(true)}
        onBlur={() => setShown(false)}
      >
        <MeterBar value={clamped} tone={tone ?? meterTone(clamped)} track={track} />
        {shown && tooltip ? (
          <ChartTooltip
            row={{ value: text, label: label ?? name ?? 'Meter' }}
            left={`clamp(24px, ${clamped * 100}%, calc(100% - 24px))`}
          />
        ) : null}
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums">{text}</span>
    </div>
  )
}
