import { ChartFrame } from './chart-frame'

export interface StackedSeries {
  key: string
  label: string
  /** The palette slot, 1 to 9 (`--vx-series-n`): fixed per entity, so a filter never repaints the survivors. */
  slot: number
}

export interface StackedBar {
  /** The bar's name in the tooltip and the table ("Week to 2026-11-09"). */
  label: string
  /** One count per series, the same order as `series`. */
  values: number[]
}

export interface StackedBarsProps {
  series: StackedSeries[]
  /** The bars left to right (the oldest first). */
  bars: StackedBar[]
  /** What a total is called in the tooltip and the table ("fix commits"). */
  unit?: string
  /** What the chart shows, for the accessible name ("Fix commits per week by class"). */
  name?: string
  /** Whether the legend (each present series with its total) shows under the bars. Default yes: two or more series need it. */
  legend?: boolean
  height?: number
  className?: string
}

/** Wider than a line chart's 24 px: a card holds a handful of bars, and a hairline bar in a wide card reads as unfinished. */
const MAX_BAR = 40
const GAP = 2
const RADIUS = 4

const colour = (slot: number) => `var(--vx-series-${Math.max(1, Math.min(9, slot))})`

/** A segment with a rounded data end when it is the top one, square at the bottom. */
function segmentPath(x: number, top: number, width: number, bottom: number, round: boolean): string {
  const r = round ? Math.min(RADIUS, width / 2, bottom - top) : 0
  return `M${x},${bottom} V${top + r} ${r ? `Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r}` : `H${x + width}`} V${bottom} Z`
}

/**
 * Stacked bars: one bar per entry, one segment per series in the series' fixed order from the baseline up, a 2 px surface
 * gap between segments, bars at most 40 px thick, the legend with each series' total, a tooltip per bar listing its
 * series, and the numbers as a hidden table. Colours are `--vx-series-n` tokens. No animation.
 */
export function StackedBars({
  series,
  bars,
  unit = 'total',
  name = 'Stacked bars',
  legend = true,
  height = 88,
  className,
}: StackedBarsProps) {
  const n = bars.length
  const totals = bars.map((bar) => bar.values.reduce((a, b) => a + b, 0))
  const seriesTotals = series.map((_, s) => bars.reduce((sum, bar) => sum + (bar.values[s] ?? 0), 0))
  const present = series.map((s, i) => ({ ...s, total: seriesTotals[i] ?? 0 })).filter((s) => s.total > 0)
  const rows = bars.map((bar, i) => ({
    label: bar.label,
    value: `${totals[i]} ${unit}`,
    lines: series.flatMap((s, k) => ((bar.values[k] ?? 0) > 0 ? [`${s.label} ${bar.values[k]}`] : [])),
  }))
  const slot = (width: number) => width / Math.max(1, n)
  const summary = `${name}: ${n} bars, ${totals.reduce((a, b) => a + b, 0)} ${unit} in all`

  return (
    <div className={className}>
      <ChartFrame
        height={height}
        summary={summary}
        rows={rows}
        initialIndex={Math.max(0, n - 1)}
        indexAt={(x, width) => Math.floor(x / slot(width))}
        anchorX={(i, width) => (i + 0.5) * slot(width)}
      >
        {({ width, active }) => {
          const max = Math.max(1, ...totals)
          const stacked = Math.max(1, ...bars.map((bar) => bar.values.filter((v) => v > 0).length))
          const scale = (height - 2 - GAP * (stacked - 1)) / max
          const thick = Math.min(MAX_BAR, slot(width) - GAP)
          return (
            <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
              <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--vx-grid)" strokeWidth={1} />
              {bars.map((bar, i) => {
                const x = i * slot(width) + (slot(width) - thick) / 2
                const filled = series.flatMap((s, k) =>
                  (bar.values[k] ?? 0) > 0 ? [{ s, count: bar.values[k] ?? 0 }] : [],
                )
                let bottom = height
                return (
                  <g key={bar.label} opacity={active === null || active === i ? 1 : 0.55}>
                    {filled.map(({ s, count }, k) => {
                      const top = bottom - Math.max(3, count * scale)
                      const path = segmentPath(x, top, thick, bottom, k === filled.length - 1)
                      bottom = top - GAP
                      return <path key={s.key} d={path} fill={colour(s.slot)} />
                    })}
                  </g>
                )
              })}
            </svg>
          )
        }}
      </ChartFrame>
      {legend ? (
        <ul
          aria-label={`${name}: legend`}
          className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--vx-text-sm)]"
        >
          {present.length === 0 ? <li className="text-muted-foreground">None</li> : null}
          {present.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: colour(s.slot) }}
              />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-medium tabular-nums">{s.total}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
