import { useState } from 'react'
import { ChartTooltip } from './chart-frame'
import { mix, TONE_MARK, type Tone } from './tone'
import { cn } from '@/lib/utils'

export interface MeterProps {
  /** 0 to 1. */
  value: number
  /** Text beside the bar ("Weekly window"). */
  label?: string
  /** The value as words; default the percentage. */
  valueText?: string
  className?: string
}

/** Accent below 70 %, warn from 70 %, bad from 90 %. */
export function meterTone(value: number): Tone {
  if (value >= 0.9) return 'bad'
  if (value >= 0.7) return 'warn'
  return 'accent'
}

/** A thin rounded bar, its track a lighter step of the fill's own hue. Shows its value on hover and focus. */
export function Meter({ value, label, valueText, className }: MeterProps) {
  const [shown, setShown] = useState(false)
  const clamped = Math.max(0, Math.min(1, value))
  const text = valueText ?? `${Math.round(clamped * 100)} %`
  const mark = TONE_MARK[meterTone(clamped)]
  return (
    <div className={cn('flex items-center gap-3 text-[length:var(--vx-text-sm)]', className)}>
      {label ? <span className="w-28 shrink-0 text-muted-foreground">{label}</span> : null}
      <div
        role="meter"
        tabIndex={0}
        aria-label={label ?? 'Meter'}
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
        <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: mix(mark, 18) }}>
          <div className="h-full rounded-full" style={{ width: `${clamped * 100}%`, background: mark }} />
        </div>
        {shown ? (
          <ChartTooltip
            row={{ value: text, label: label ?? 'Meter' }}
            left={`clamp(24px, ${clamped * 100}%, calc(100% - 24px))`}
          />
        ) : null}
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums">{text}</span>
    </div>
  )
}
