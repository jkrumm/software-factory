import { WORK_TREND_KEYS, type WorkTrendKey } from '@software-factory/contract'
import { useState } from 'react'
import { InfoHint, Segments, TimeChart } from '@/components/kit'
import { useWindowKeys } from '@/components/shortcuts'
import { bucketWords, DEFAULT_TREND_RANGE, TREND_RANGES, type TrendRange, trendLines } from '@/lib/flow'
import { useFlowTrend } from '@/lib/queries'

const COUNT_LABEL: Record<WorkTrendKey, string> = {
  running: 'Running',
  paused: 'Paused',
  notStarted: 'Not started',
  checking: 'Checking',
}

/** The word each series is defined under in `docs/language.md`. */
const COUNT_WORD = { running: 'running', paused: 'paused', notStarted: 'not started', checking: 'checking' } as const

/** The windows from shorter to longer: `[` and `]` step through them. */
const RANGE_KEYS = TREND_RANGES.map((choice) => choice.key)

/**
 * Issues over time: the peak and the average of one count (running, paused, not started or checking) in every bucket of a window,
 * from the server's applied events, so a daytime peak between two instants still shows. The window and the bucket are
 * chosen in the chart's own frame; both lines are plotted from zero.
 */
export function TrendChart() {
  const [rangeKey, setRangeKey] = useState<TrendRange['key']>(DEFAULT_TREND_RANGE.key)
  const [count, setCount] = useState<WorkTrendKey>('running')
  useWindowKeys(RANGE_KEYS, rangeKey, setRangeKey)
  const range = TREND_RANGES.find((choice) => choice.key === rangeKey) ?? DEFAULT_TREND_RANGE
  const { data, error, isPending } = useFlowTrend(range.window, range.bucket)
  const lines = data ? trendLines(data, count) : null
  const peak = lines ? Math.max(0, ...lines.peak) : 0
  const word = (ms: number) => bucketWords(ms, range.bucket)
  return (
    <div
      role="group"
      aria-label="Issues over time"
      data-testid="flow-trend"
      className="mb-4 flex min-w-0 flex-col gap-3 rounded-xl bg-card p-3 text-card-foreground"
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <div className="mr-auto min-w-0">
          <h2 className="flex items-center gap-0.5 text-[length:var(--vx-text-md)] leading-tight font-semibold tracking-tight">
            Issues over time
            <InfoHint word={COUNT_WORD[count]} className="-my-1" />
          </h2>
          <p className="text-xs text-muted-foreground">
            Issues, never sessions: the most at any instant of {range.bucket === 'hour' ? 'an hour' : 'a day'} and the
            average over it
          </p>
        </div>
        <Segments
          label="Count"
          choices={WORK_TREND_KEYS.map((key) => ({ key, label: COUNT_LABEL[key] }))}
          value={count}
          onChange={setCount}
        />
        <Segments label="Window" choices={TREND_RANGES} value={rangeKey} onChange={setRangeKey} />
      </header>
      <div className="rounded-lg bg-background px-4 py-3.5">
        {lines ? (
          <>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
              <span>
                <span
                  data-testid="trend-peak"
                  className="text-[length:var(--vx-text-display)] leading-none font-semibold text-foreground tabular-nums"
                >
                  {peak}
                </span>{' '}
                peak {COUNT_LABEL[count].toLowerCase()} in the window
              </span>
              <span className="ml-auto flex items-center gap-4 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-4 rounded-full"
                    style={{ background: 'var(--vx-accent)' }}
                  />
                  Peak
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-4 rounded-full"
                    style={{ background: 'var(--vx-line2)' }}
                  />
                  Average
                </span>
              </span>
            </div>
            <TimeChart
              name={`${COUNT_LABEL[count]} Issues`}
              times={lines.times}
              timeLabel={word}
              series={[
                { name: 'Average', values: lines.avg, tone: 'neutral', area: true },
                { name: 'Peak', values: lines.peak, tone: 'accent' },
              ]}
              format={(value) => (Number.isInteger(value) ? String(value) : value.toFixed(1))}
              height={160}
            />
            <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>{word(lines.times[0] ?? 0)}</span>
              <span>{range.bucket === 'day' ? 'Days are UTC days' : 'Now'}</span>
              <span>{word(lines.times.at(-1) ?? 0)}</span>
            </div>
          </>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {isPending
              ? 'Reading the events…'
              : `The trend could not be read${error ? `: ${error.message}` : ''}. Reload the page to try again.`}
          </p>
        )}
      </div>
    </div>
  )
}
