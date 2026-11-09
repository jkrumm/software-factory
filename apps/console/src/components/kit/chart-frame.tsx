import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** One point of a chart as the tooltip and the hidden table say it. */
export interface ChartRow {
  label: string
  value: string
}

/** Value first and strong, label second. React text nodes only. */
export function ChartTooltip({ row, left, className }: { row: ChartRow; left: number | string; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap',
        className,
      )}
      style={{
        left,
        top: -6,
        background: 'var(--vx-tooltip-bg)',
        boxShadow: 'var(--vx-tooltip-shadow)',
      }}
    >
      <div className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--vx-tooltip-text)' }}>
        {row.value}
      </div>
      <div style={{ color: 'var(--vx-tooltip-muted)' }}>{row.label}</div>
    </div>
  )
}

const TOOLTIP_EDGE = 48

interface ChartFrameProps {
  height: number
  /** What the chart shows with its range, for the accessible name and the hidden table's caption. */
  summary: string
  rows: ChartRow[]
  /** The point under a pointer at `x` px from the left edge. */
  indexAt: (x: number, width: number) => number
  /** Where the tooltip of a point is centred, px from the left edge. */
  anchorX: (index: number, width: number) => number
  /** The point a keyboard focus starts on. */
  initialIndex: number
  className?: string
  children: (chart: { width: number; active: number | null }) => ReactNode
}

/**
 * The shell every chart shares: it measures its width, finds the point under the pointer or the arrow keys, shows the
 * tooltip, and carries the numbers as a visually hidden table. The whole frame is the hit target (at least 24 px tall).
 */
export function ChartFrame({
  height,
  summary,
  rows,
  indexAt,
  anchorX,
  initialIndex,
  className,
  children,
}: ChartFrameProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const last = rows.length - 1
  const clamp = (index: number) => Math.max(0, Math.min(last, index))

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (width === 0 || last < 0) return
    setActive(clamp(indexAt(event.clientX - event.currentTarget.getBoundingClientRect().left, width)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    if (step !== undefined) setActive((current) => clamp((current ?? initialIndex) + step))
    else if (event.key === 'Home') setActive(0)
    else if (event.key === 'End') setActive(last)
    else return
    event.preventDefault()
  }

  const row = active === null ? undefined : rows[active]
  return (
    <div
      ref={ref}
      role="group"
      aria-label={summary}
      tabIndex={0}
      className={cn(
        'relative w-full min-w-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
      style={{ height: Math.max(24, height) }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive((current) => current ?? clamp(initialIndex))}
      onBlur={() => setActive(null)}
      onKeyDown={onKeyDown}
    >
      {width > 0 ? children({ width, active }) : null}
      {row && active !== null ? (
        <ChartTooltip row={row} left={Math.max(TOOLTIP_EDGE, Math.min(width - TOOLTIP_EDGE, anchorX(active, width)))} />
      ) : null}
      <table className="sr-only">
        <caption>{summary}</caption>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** "12 values from 3 to 40, latest 31" */
export function rangeSummary(name: string, values: number[], format: (value: number) => string): string {
  if (values.length === 0) return `${name}: no values`
  return `${name}: ${values.length} values from ${format(Math.min(...values))} to ${format(Math.max(...values))}, latest ${format(values[values.length - 1] ?? 0)}`
}
