import { ChartFrame } from './chart-frame'
import { nearestTime, runsOf } from './time-series'
import { mix, TONE_MARK, type Tone } from './tone'

export interface TimeSeries {
  /** Names the series in the tooltip when the chart holds more than one. */
  name: string
  /** One reading per time; `null` is a gap, never drawn as zero. */
  values: (number | null)[]
  tone: Tone
  /** The line's colour when a tone is not enough to tell two series apart (a CSS value, a token). */
  mark?: string
  /** An area at 10 % under the line. */
  area?: boolean
}

export interface TimeChartProps {
  /** What the chart shows ("Load"), for the accessible name. */
  name: string
  /** Epoch ms of each reading, ascending. */
  times: number[]
  series: TimeSeries[]
  /** A ceiling or target as a dashed line; kept in the range only when it is not far off the data. */
  reference?: number
  format: (value: number) => string
  height?: number
  /** Told when the point under the pointer changes (null when it leaves), so a figure beside the chart can follow it. */
  onActiveChange?: (index: number | null) => void
  className?: string
}

const PAD_X = 4
const PAD_Y = 6
/** A reference further above the data than this multiple is left off the chart rather than flattening the line. */
const REFERENCE_REACH = 4

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/**
 * Readings over time on a true time axis: 2 px lines, hairline gridlines, an optional dashed reference, a crosshair and a
 * tooltip with the time and every series' value (pointer or arrow keys). The axis starts at zero. No animation.
 */
export function TimeChart({
  name,
  times,
  series,
  reference,
  format,
  height = 64,
  onActiveChange,
  className,
}: TimeChartProps) {
  const n = times.length
  const first = times[0] ?? 0
  const span = (times[n - 1] ?? first) - first
  const readings = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const top = Math.max(0, ...readings)
  const showReference = reference !== undefined && reference <= Math.max(top, 1) * REFERENCE_REACH
  const ceiling = Math.max(top, showReference ? (reference ?? 0) : 0) * 1.08 || 1
  const xOf = (i: number, width: number) =>
    span > 0 ? PAD_X + (((times[i] ?? first) - first) / span) * (width - 2 * PAD_X) : width / 2
  const yOf = (value: number) => PAD_Y + (1 - value / ceiling) * (height - 2 * PAD_Y)

  const rows = times.map((at, i) => ({
    label: clock(at),
    value: series
      .map((s) => {
        const v = s.values[i]
        const text = v === null || v === undefined ? '-' : format(v)
        return series.length > 1 ? `${s.name} ${text}` : text
      })
      .join(' · '),
  }))
  const latest = Math.max(0, n - 1)
  const summary = `${name}, last ${Math.max(1, Math.round(span / 3_600_000))} h: ${
    series.length > 1 ? series.map((s) => s.name).join(' and ') : `latest ${rows[latest]?.value ?? '-'}`
  }`

  return (
    <ChartFrame
      height={height}
      summary={summary}
      rows={rows}
      className={className}
      initialIndex={latest}
      onActiveChange={onActiveChange}
      tooltip="inside"
      indexAt={(x, width) => nearestTime(times, first + (span * (x - PAD_X)) / Math.max(1, width - 2 * PAD_X))}
      anchorX={xOf}
    >
      {({ width, active }) => (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
          {[PAD_Y, height / 2, height - PAD_Y].map((line) => (
            <line key={line} x1={0} x2={width} y1={line} y2={line} stroke="var(--vx-grid)" strokeWidth={1} />
          ))}
          {showReference && reference !== undefined ? (
            <line
              x1={0}
              x2={width}
              y1={yOf(reference)}
              y2={yOf(reference)}
              stroke="var(--vx-faint)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ) : null}
          {series.map((s) => {
            const mark = s.mark ?? TONE_MARK[s.tone]
            return runsOf(s.values).map(([from, to]) => {
              const points: string[] = []
              for (let i = from; i <= to; i++)
                points.push(`${xOf(i, width).toFixed(1)},${yOf(s.values[i] ?? 0).toFixed(1)}`)
              const line = points.join(' ')
              return (
                <g key={`${s.name}-${from}`}>
                  {s.area && to > from ? (
                    <polygon
                      points={`${xOf(from, width).toFixed(1)},${height - PAD_Y} ${line} ${xOf(to, width).toFixed(1)},${height - PAD_Y}`}
                      fill={mix(mark, 10)}
                    />
                  ) : null}
                  <polyline
                    points={to > from ? line : `${line} ${line}`}
                    fill="none"
                    stroke={mark}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              )
            })
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
          {series.map((s) => {
            const at = active ?? latest
            const value = s.values[at]
            if (value === null || value === undefined) return null
            return (
              <circle
                key={s.name}
                cx={xOf(at, width)}
                cy={yOf(value)}
                r={4}
                fill={s.mark ?? TONE_MARK[s.tone]}
                stroke="var(--vx-dot-stroke)"
                strokeWidth={2}
              />
            )
          })}
        </svg>
      )}
    </ChartFrame>
  )
}
