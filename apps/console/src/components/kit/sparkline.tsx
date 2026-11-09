import { ChartFrame, rangeSummary } from './chart-frame'
import { mix, TONE_MARK, type Tone } from './tone'

export interface SparklineProps {
  values: number[]
  /** One label per value, for the tooltip's second line (default: "Point n"). */
  labels?: string[]
  /** The first index that is the future: the line from the last known point on is dashed and has no area. */
  futureFrom?: number
  /** A target drawn as a dashed horizontal reference line, and kept inside the vertical range. */
  target?: number
  /** The line's colour: `neutral` is the quiet grey line. Text is never in this colour. */
  tone?: Tone
  /** What the values are, for the accessible name ("Working"). */
  name?: string
  /** How a value reads in the tooltip and the hidden table. */
  format?: (value: number) => string
  height?: number
  className?: string
}

const PAD_X = 8
const PAD_Y = 8
const DOT_RADIUS = 4

/**
 * A 2 px line with an area at 10 %, a dot at the latest known point, hairline gridlines, and a tooltip on the nearest
 * point (pointer or arrow keys). No animation.
 */
export function Sparkline({
  values,
  labels,
  futureFrom,
  target,
  tone = 'accent',
  name = 'Series',
  format = String,
  height = 56,
  className,
}: SparklineProps) {
  const n = values.length
  const now = futureFrom !== undefined && futureFrom > 0 ? Math.min(futureFrom, n) - 1 : n - 1
  const mark = TONE_MARK[tone]
  const rows = values.map((value, i) => ({
    label: `${labels?.[i] ?? `Point ${i + 1}`}${futureFrom !== undefined && i >= futureFrom ? ' (projected)' : ''}`,
    value: format(value),
  }))
  const summary = `${rangeSummary(name, values, format)}${target === undefined ? '' : `, target ${format(target)}`}`
  const stepOf = (width: number) => (n > 1 ? (width - 2 * PAD_X) / (n - 1) : 0)
  const xOf = (i: number, width: number) => (n > 1 ? PAD_X + i * stepOf(width) : width / 2)

  return (
    <ChartFrame
      height={height}
      summary={summary}
      rows={rows}
      className={className}
      initialIndex={Math.max(0, now)}
      indexAt={(x, width) => (n > 1 ? Math.round((x - PAD_X) / stepOf(width)) : 0)}
      anchorX={xOf}
    >
      {({ width, active }) => {
        const all = target === undefined ? values : [...values, target]
        const min = Math.min(...all)
        const span = Math.max(...all) - min || 1
        const y = (value: number) => PAD_Y + (1 - (value - min) / span) * (height - 2 * PAD_Y)
        const point = (i: number) => `${xOf(i, width).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`
        const solid = values.slice(0, now + 1).map((_, i) => point(i))
        const dashed = values.slice(now, n).map((_, i) => point(now + i))
        const baseline = height
        const activeX = active === null ? null : xOf(active, width)
        const activeY = active === null ? null : y(values[active] ?? 0)
        return (
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            {[PAD_Y, height / 2, height - PAD_Y].map((line) => (
              <line key={line} x1={0} x2={width} y1={line} y2={line} stroke="var(--vx-grid)" strokeWidth={1} />
            ))}
            {target === undefined ? null : (
              <line
                x1={0}
                x2={width}
                y1={y(target)}
                y2={y(target)}
                stroke="var(--vx-faint)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            )}
            {solid.length > 1 ? (
              <polygon
                points={`${xOf(0, width)},${baseline} ${solid.join(' ')} ${xOf(now, width)},${baseline}`}
                fill={mix(mark, 10)}
              />
            ) : null}
            {solid.length > 1 ? (
              <polyline
                points={solid.join(' ')}
                fill="none"
                stroke={mark}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {dashed.length > 1 ? (
              <polyline
                points={dashed.join(' ')}
                fill="none"
                stroke={mark}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray="4 4"
              />
            ) : null}
            {activeX === null || activeY === null ? null : (
              <line x1={activeX} x2={activeX} y1={0} y2={height} stroke="var(--vx-crosshair)" strokeWidth={1} />
            )}
            {n > 0 ? (
              <circle
                cx={xOf(active ?? now, width)}
                cy={y(values[active ?? now] ?? 0)}
                r={DOT_RADIUS}
                fill={mark}
                stroke="var(--vx-dot-stroke)"
                strokeWidth={2}
              />
            ) : null}
          </svg>
        )
      }}
    </ChartFrame>
  )
}
