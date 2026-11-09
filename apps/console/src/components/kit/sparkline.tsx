import { ChartFrame, rangeSummary } from './chart-frame'
import { mix, TONE_MARK, type Tone } from './tone'
import { runsOf } from './time-series'

export interface SparklineProps {
  /** A `null` is a gap: the line breaks there instead of dropping to zero. */
  values: (number | null)[]
  /** One label per value, for the tooltip's second line (default: "Point n"). */
  labels?: string[]
  /** The first index that is the future: the line from the last known point on is dashed and has no area. */
  futureFrom?: number
  /** A target drawn as a dashed horizontal reference line (a range: two lines and a faint band), and kept inside the vertical range. */
  target?: number | { min: number; max: number }
  /** The line's colour: `neutral` is the quiet grey line. Text is never in this colour. */
  tone?: Tone
  /** What the values are, for the accessible name ("Working"). */
  name?: string
  /** How a value reads in the tooltip and the hidden table. */
  format?: (value: number) => string
  /** How a gap reads in the tooltip and the hidden table. */
  emptyText?: string
  height?: number
  className?: string
}

const PAD_X = 8
const PAD_Y = 8
const DOT_RADIUS = 4

const targetsOf = (target: SparklineProps['target']): number[] =>
  target === undefined ? [] : typeof target === 'number' ? [target] : [target.min, target.max]

/**
 * A 2 px line with an area at 10 %, a dot at the latest known point, hairline gridlines, and a tooltip on the nearest
 * point (pointer or arrow keys). A gap in the values breaks the line. No animation.
 */
export function Sparkline({
  values,
  labels,
  futureFrom,
  target,
  tone = 'accent',
  name = 'Series',
  format = String,
  emptyText = 'No data',
  height = 56,
  className,
}: SparklineProps) {
  const n = values.length
  const known = values.filter((v): v is number => v !== null)
  const targets = targetsOf(target)
  const lastKnown = values.reduce<number>((last, v, i) => (v === null ? last : i), -1)
  const now = futureFrom !== undefined && futureFrom > 0 ? Math.min(futureFrom, n) - 1 : n - 1
  const mark = TONE_MARK[tone]
  const rows = values.map((value, i) => ({
    label: `${labels?.[i] ?? `Point ${i + 1}`}${futureFrom !== undefined && i >= futureFrom ? ' (projected)' : ''}`,
    value: value === null ? emptyText : format(value),
  }))
  const targetWords = targets.length === 0 ? '' : `, target ${targets.map(format).join(' to ')}`
  const summary = `${rangeSummary(name, known, format)}${targetWords}`
  const stepOf = (width: number) => (n > 1 ? (width - 2 * PAD_X) / (n - 1) : 0)
  const xOf = (i: number, width: number) => (n > 1 ? PAD_X + i * stepOf(width) : width / 2)

  return (
    <ChartFrame
      height={height}
      summary={summary}
      rows={rows}
      className={className}
      initialIndex={Math.max(0, lastKnown < 0 ? now : Math.min(now, lastKnown))}
      indexAt={(x, width) => (n > 1 ? Math.round((x - PAD_X) / stepOf(width)) : 0)}
      anchorX={xOf}
    >
      {({ width, active }) => {
        const all = [...known, ...targets]
        const min = all.length === 0 ? 0 : Math.min(...all)
        const span = (all.length === 0 ? 0 : Math.max(...all) - min) || 1
        const y = (value: number) => PAD_Y + (1 - (value - min) / span) * (height - 2 * PAD_Y)
        const point = (i: number) => `${xOf(i, width).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`
        const range = (from: number, to: number) =>
          Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k)
        const runs = runsOf(values)
        const baseline = height
        const dotIndex = active ?? Math.min(now, lastKnown)
        const dotValue = dotIndex < 0 ? null : (values[dotIndex] ?? null)
        const line = (stroke: string, dash?: string) => ({
          fill: 'none',
          stroke,
          strokeWidth: 2,
          strokeLinejoin: 'round' as const,
          strokeLinecap: 'round' as const,
          strokeDasharray: dash,
        })
        return (
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            {[PAD_Y, height / 2, height - PAD_Y].map((gridLine) => (
              <line
                key={gridLine}
                x1={0}
                x2={width}
                y1={gridLine}
                y2={gridLine}
                stroke="var(--vx-grid)"
                strokeWidth={1}
              />
            ))}
            {typeof target === 'object' ? (
              <rect
                x={0}
                width={width}
                y={y(target.max)}
                height={Math.max(0, y(target.min) - y(target.max))}
                fill={mix('var(--vx-faint)', 10)}
              />
            ) : null}
            {targets.map((value) => (
              <line
                key={value}
                x1={0}
                x2={width}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--vx-faint)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ))}
            {runs.map(([from, to]) => {
              const solid = range(from, Math.min(to, now)).map(point)
              const dashed = to > now ? range(Math.max(from, now), to).map(point) : []
              return (
                <g key={from}>
                  {solid.length > 1 ? (
                    <polygon
                      points={`${xOf(from, width)},${baseline} ${solid.join(' ')} ${xOf(Math.min(to, now), width)},${baseline}`}
                      fill={mix(mark, 10)}
                    />
                  ) : null}
                  {solid.length > 1 ? <polyline points={solid.join(' ')} {...line(mark)} /> : null}
                  {dashed.length > 1 ? <polyline points={dashed.join(' ')} {...line(mark, '4 4')} /> : null}
                  {from === to ? <circle cx={xOf(from, width)} cy={y(values[from] ?? 0)} r={2.5} fill={mark} /> : null}
                </g>
              )
            })}
            {active === null ? null : (
              <line
                x1={xOf(active, width)}
                x2={xOf(active, width)}
                y1={0}
                y2={height}
                stroke="var(--vx-crosshair)"
                strokeWidth={1}
              />
            )}
            {dotValue === null ? null : (
              <circle
                cx={xOf(dotIndex, width)}
                cy={y(dotValue)}
                r={DOT_RADIUS}
                fill={mark}
                stroke="var(--vx-dot-stroke)"
                strokeWidth={2}
              />
            )}
          </svg>
        )
      }}
    </ChartFrame>
  )
}
