import { ChartFrame, rangeSummary } from './chart-frame'
import { mix } from './tone'

export interface MiniBarsProps {
  values: number[]
  /** One label per bar, for the tooltip's second line (default: "Bar n"). */
  labels?: string[]
  /** The bar painted in the accent; the others are muted. Default: the last. */
  highlight?: number
  /** What the values are, for the accessible name ("Queued"). */
  name?: string
  format?: (value: number) => string
  height?: number
  className?: string
}

const MAX_BAR = 24
const GAP = 2
const RADIUS = 4

/** A bar with a rounded data end and a square baseline. */
function barPath(x: number, top: number, width: number, bottom: number): string {
  const r = Math.min(RADIUS, width / 2, bottom - top)
  return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${bottom} Z`
}

/** Bars at most 24 px thick with a 2 px gap, one accent bar, a per-bar tooltip. No animation. */
export function MiniBars({
  values,
  labels,
  highlight,
  name = 'Series',
  format = String,
  height = 56,
  className,
}: MiniBarsProps) {
  const n = values.length
  const accent = highlight ?? n - 1
  const rows = values.map((value, i) => ({ label: labels?.[i] ?? `Bar ${i + 1}`, value: format(value) }))
  const slot = (width: number) => width / Math.max(1, n)

  return (
    <ChartFrame
      height={height}
      summary={rangeSummary(name, values, format)}
      rows={rows}
      className={className}
      initialIndex={Math.max(0, accent)}
      indexAt={(x, width) => Math.floor(x / slot(width))}
      anchorX={(i, width) => (i + 0.5) * slot(width)}
    >
      {({ width, active }) => {
        const max = Math.max(1, ...values)
        const thick = Math.min(MAX_BAR, slot(width) - GAP)
        return (
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--vx-grid)" strokeWidth={1} />
            {values.map((value, i) => {
              const barHeight = Math.max(2, (value / max) * (height - 2))
              const fill = i === accent ? 'var(--vx-accent)' : mix('var(--vx-faint)', i === active ? 55 : 35)
              return (
                <path
                  key={i}
                  d={barPath(i * slot(width) + (slot(width) - thick) / 2, height - barHeight, thick, height)}
                  fill={fill}
                />
              )
            })}
          </svg>
        )
      }}
    </ChartFrame>
  )
}
