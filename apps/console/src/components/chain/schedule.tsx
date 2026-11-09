import { useEffect, useRef, useState } from 'react'
import type { ChainNode } from '@software-factory/contract'
import { mix, TONE_MARK } from '@/components/kit/tone'
import { dateWords, scheduleOf, type ScheduleItem, untilWords, utcWords } from '@/lib/chain'
import { useNow } from '@/lib/now'
import { cn } from '@/lib/utils'

const CHIP_REM = 13
const LANE_REM = 5
const AXIS_REM = 2.5
/** the stem between the dot and the lowest chip */
const STEM_REM = 0.75
const REM_PX = 16

/** Secondary text on the band: one step stronger than the muted token, at 12 px. */
const TEXT2 = 'text-xs text-[color:var(--vx-ink2)]'

const GRID = mix('var(--vx-ink)', 14)
const AXIS = mix('var(--vx-ink)', 60)
const STEM = mix('var(--vx-ink)', 45)

const iso = (item: ScheduleItem): string => item.node.notBefore ?? ''

function Chip({
  item,
  now,
  className,
  style,
}: {
  item: ScheduleItem
  now: number
  className?: string
  style?: React.CSSProperties
}) {
  const { node } = item
  return (
    <div
      data-testid="schedule-item"
      className={cn(
        'chain-card flex flex-col gap-0.5 rounded-lg bg-card px-2.5 py-1.5 text-xs text-card-foreground',
        className,
      )}
      style={{ boxShadow: 'var(--vx-shadow-raised)', ...style }}
    >
      <span className="truncate text-[length:var(--vx-text-sm)] font-medium" title={node.title}>
        {node.title}
      </span>
      <time dateTime={iso(item)} title={utcWords(iso(item))} className="font-mono tabular-nums">
        {dateWords(iso(item), now)}
      </time>
      <span className={cn('truncate', TEXT2)}>
        {node.repo ?? 'No project'} · {untilWords(item.at - now)}
      </span>
    </div>
  )
}

/** Two short slashes across the axis: the scale breaks here. */
function BreakMark() {
  return (
    <svg
      viewBox="0 0 14 16"
      className="absolute size-4"
      style={{ left: 0, bottom: `${AXIS_REM}rem`, transform: 'translateY(50%)' }}
      aria-hidden="true"
    >
      <rect x="0" y="5" width="14" height="6" style={{ fill: 'var(--chain-canvas)' }} />
      <line x1="2" y1="12" x2="6" y2="4" stroke="var(--vx-ink)" strokeWidth="1.5" />
      <line x1="8" y1="12" x2="12" y2="4" stroke="var(--vx-ink)" strokeWidth="1.5" />
    </svg>
  )
}

/** The plan rows that wait for a date, on a time axis from now. A row past the horizon sits in the Later cell. */
export function Schedule({ nodes }: { nodes: ChainNode[] }) {
  const now = useNow(60_000)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const gap = width > 0 ? Math.min(1, (CHIP_REM * REM_PX + 8) / width) : 0.2
  const schedule = scheduleOf(nodes, now, gap)
  const onAxis = schedule.items.filter((item) => !item.later)
  const later = schedule.items.filter((item) => item.later)
  const lanes = Math.max(1, schedule.lanes)
  const height = `${lanes * LANE_REM + AXIS_REM + STEM_REM}rem`
  const pct = (position: number): string => `${position * 100}%`
  // a label is about 8 px a character in mono at 12 px, plus air: when they would touch, name every nth tick
  const closest = schedule.ticks.reduce(
    (least, tick, i) => (i === 0 ? least : Math.min(least, tick.position - (schedule.ticks[i - 1]?.position ?? 0))),
    1,
  )
  const labelPx = (schedule.ticks[0]?.label.length ?? 6) * 8 + 16
  const every = width > 0 && closest > 0 ? Math.max(1, Math.ceil(labelPx / (closest * width))) : 1

  return (
    <section role="region" aria-label="Schedule" className="mt-6 flex min-w-0 shrink-0 flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[length:var(--vx-text-md)] font-semibold tracking-tight">Schedule</h2>
        <p className="text-sm text-[color:var(--vx-ink2)]">
          {schedule.items.length} {schedule.items.length === 1 ? 'row waits' : 'rows wait'} for a date
        </p>
      </div>
      <div className="chain-canvas overflow-x-auto rounded-xl">
        <div className="flex min-w-[48rem]">
          <div className="relative min-w-0 flex-1" style={{ height }}>
            <div
              className="absolute right-0 left-6"
              style={{ bottom: `${AXIS_REM}rem`, height: 1, background: AXIS }}
            />
            <div
              ref={box}
              aria-hidden="true"
              className="absolute inset-y-0 left-8"
              style={{ right: `${CHIP_REM + 1}rem` }}
            >
              {schedule.ticks.map((tick) => (
                <div
                  key={tick.at}
                  className="absolute w-px"
                  style={{ left: pct(tick.position), bottom: `${AXIS_REM}rem`, top: '0.5rem', background: GRID }}
                />
              ))}
              <div
                className="absolute w-px"
                style={{ left: 0, bottom: `${AXIS_REM}rem`, top: '0.5rem', background: AXIS }}
              />
              <div
                className={cn(TEXT2, 'absolute font-mono font-medium whitespace-nowrap text-foreground')}
                style={{ left: 0, bottom: `${AXIS_REM - 1.6}rem`, transform: 'translateX(-50%)' }}
              >
                Now
              </div>
              {schedule.ticks.map((tick, i) =>
                i % every !== 0 ? null : (
                  <div
                    key={`label-${tick.at}`}
                    className={cn('absolute font-mono whitespace-nowrap tabular-nums', TEXT2)}
                    style={{ left: pct(tick.position), bottom: `${AXIS_REM - 1.6}rem`, transform: 'translateX(-50%)' }}
                  >
                    {tick.label}
                  </div>
                ),
              )}
              {onAxis.map((item) => (
                <div key={`stem-${item.node.id}`}>
                  <div
                    className="absolute w-px"
                    style={{
                      left: pct(item.position),
                      bottom: `${AXIS_REM}rem`,
                      height: `${STEM_REM + item.lane * LANE_REM}rem`,
                      background: STEM,
                    }}
                  />
                  <div
                    className="absolute size-2 rounded-full"
                    style={{
                      left: pct(item.position),
                      bottom: `${AXIS_REM}rem`,
                      transform: 'translate(-50%, 50%)',
                      background: TONE_MARK[item.due ? 'warn' : 'accent'],
                    }}
                  />
                </div>
              ))}
              {onAxis.map((item) => (
                <Chip
                  key={item.node.id}
                  item={item}
                  now={now}
                  className="absolute"
                  style={{
                    left: pct(item.position),
                    bottom: `${AXIS_REM + STEM_REM + item.lane * LANE_REM}rem`,
                    width: `${CHIP_REM}rem`,
                  }}
                />
              ))}
            </div>
          </div>
          {later.length > 0 ? (
            <div
              aria-hidden="true"
              className="relative flex w-60 shrink-0 flex-col gap-2 p-3"
              style={{ minHeight: height, paddingBottom: `${AXIS_REM + 0.75}rem` }}
            >
              <h3 className={cn(TEXT2, 'font-medium text-foreground')}>Later</h3>
              {later.map((item) => (
                <Chip key={item.node.id} item={item} now={now} />
              ))}
              <div
                className="absolute right-3 left-4"
                style={{ bottom: `${AXIS_REM}rem`, height: 1, background: AXIS, opacity: 0.6 }}
              />
              <BreakMark />
              <span className={cn('absolute left-3', TEXT2)} style={{ bottom: `${AXIS_REM - 1.6}rem` }}>
                beyond 120 days
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="sr-only">
        <table>
          <caption>Plan rows that wait for a date, soonest first</caption>
          <thead>
            <tr>
              <th>Row</th>
              <th>Project</th>
              <th>Not before</th>
              <th>UTC</th>
              <th>From now</th>
            </tr>
          </thead>
          <tbody>
            {schedule.items.map((item) => (
              <tr key={item.node.id}>
                <td>{item.node.title}</td>
                <td>{item.node.repo ?? 'No project'}</td>
                <td>{dateWords(iso(item), now)}</td>
                <td>{utcWords(iso(item))}</td>
                <td>{untilWords(item.at - now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
