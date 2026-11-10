import type { HostProcess } from '@software-factory/contract'
import { type ReactNode, useState } from 'react'
import { EmptyState } from '@/components/kit/empty-state'
import { TimeChart, type TimeSeries } from '@/components/kit/time-chart'
import { PopoverTitle } from '@/components/ui/popover'
import { useHost, useMachine } from '@/lib/queries'
import { historySpan, spanLabel } from '@/lib/strip'
import { cn } from '@/lib/utils'

const PROCESS_ROWS = 5
/** The charts are graphite: memory and load in ink, swap one step lighter. */
const INK_MARK = 'var(--vx-ink2)'
const SWAP_MARK = 'var(--vx-faint)'

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const oneDecimal = (value: number): string => String(Math.round(value * 10) / 10)
const percent = (value: number): string => `${Math.round(value)} %`
const mebibytes = (value: number): string => `${Math.round(value).toLocaleString('en-GB')} MiB`

/** One chart with its current figure at the left and the three x labels under it. */
function ChartRow({
  title,
  span,
  figures,
  when,
  hovering,
  children,
}: {
  title: string
  span: number
  figures: ReactNode
  /** Which reading the figures are: "now", or "at 22:59" for the point under the pointer. */
  when: string
  hovering: boolean
  children: ReactNode
}) {
  return (
    <section className="grid grid-cols-[8rem_1fr] gap-x-3" aria-label={title}>
      <div className="min-w-0">
        <h3 className="text-xs text-muted-foreground">{title}</h3>
        {figures}
        <p className={cn('text-xs tabular-nums', hovering ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {when}
        </p>
      </div>
      <div className="min-w-0">
        {children}
        <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{spanLabel(span)}</span>
          <span>{spanLabel(span / 2)}</span>
          <span>now</span>
        </div>
      </div>
    </section>
  )
}

function Figure({
  value,
  ceiling,
  swatch,
  label,
  small,
}: {
  value: string
  /** The wall the figure is measured against, muted after it ("6.2 / 60"). */
  ceiling?: string
  swatch?: string
  label?: string
  small?: boolean
}) {
  return (
    <p
      className={cn(
        'flex items-baseline gap-1.5 font-semibold whitespace-nowrap tabular-nums',
        small ? 'text-base leading-6' : 'text-xl leading-7',
      )}
    >
      {swatch ? (
        <span
          aria-hidden="true"
          className="h-0.5 w-3 shrink-0 self-center rounded-full"
          style={{ background: swatch }}
        />
      ) : null}
      {value}
      {ceiling ? <span className="text-xs font-normal text-muted-foreground">/ {ceiling}</span> : null}
      {label ? <span className="text-xs font-normal text-muted-foreground">{label}</span> : null}
    </p>
  )
}

function Processes({ title, rows, value }: { title: string; rows: HostProcess[]; value: (p: HostProcess) => string }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-xs text-muted-foreground">{title}</h3>
      <table className="w-full table-fixed text-xs">
        <thead className="sr-only">
          <tr>
            <th scope="col">Process</th>
            <th scope="col">{title}</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, PROCESS_ROWS).map((process) => (
            <tr key={process.pid} className="h-6 border-t border-border/50 first:border-t-0">
              <td className="truncate pr-2 font-mono" title={process.command}>
                {process.command}
              </td>
              <td className="w-[5.5rem] text-right tabular-nums">{value(process)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** The host over the last 24 hours: three charts with their current figures, then the busiest processes. */
export default function HostDetail() {
  const host = useHost().data
  const machine = useMachine().data
  const samples = host?.samples ?? []
  // The point under the pointer in any chart: every figure then reads that minute instead of the latest.
  const [hover, setHover] = useState<number | null>(null)
  if (!host || samples.length === 0)
    return (
      <>
        <PopoverTitle>Host, last 24 hours</PopoverTitle>
        <EmptyState title="No history yet" className="py-6">
          The server has not recorded the host yet.
        </EmptyState>
      </>
    )

  const times = samples.map((sample) => new Date(sample.at).getTime())
  const span = historySpan(samples)
  const shown = samples[hover ?? samples.length - 1]
  const when = hover === null ? 'now' : `at ${clock(times[hover] ?? 0)}`
  const hovering = hover !== null
  const column = (pick: (s: (typeof samples)[number]) => number | null) => samples.map(pick)
  const memory: TimeSeries = {
    name: 'Memory',
    values: column((s) => s.memoryUsedPct),
    tone: 'neutral',
    mark: INK_MARK,
    area: true,
  }
  const swap: TimeSeries = { name: 'Swap', values: column((s) => s.swapUsedPct), tone: 'neutral', mark: SWAP_MARK }
  const ceilings = machine?.memoryCeilings

  return (
    <>
      <PopoverTitle>Host, last 24 hours</PopoverTitle>
      <div className="mt-3 flex flex-col gap-3">
        <ChartRow
          title="Load"
          span={span}
          when={when}
          hovering={hovering}
          figures={
            <Figure
              value={shown?.load == null ? '-' : oneDecimal(shown.load)}
              ceiling={String(machine?.loadCeiling ?? '')}
            />
          }
        >
          <TimeChart
            name="Load"
            times={times}
            series={[{ name: 'Load', values: column((s) => s.load), tone: 'neutral', mark: INK_MARK, area: true }]}
            reference={machine?.loadCeiling}
            format={oneDecimal}
            onActiveChange={setHover}
          />
        </ChartRow>
        <ChartRow
          title="Memory and swap"
          span={span}
          when={when}
          hovering={hovering}
          figures={
            <>
              <Figure
                value={shown?.memoryUsedPct == null ? '-' : percent(shown.memoryUsedPct)}
                swatch={INK_MARK}
                small
                label="memory"
              />
              <Figure
                value={shown?.swapUsedPct == null ? '-' : percent(shown.swapUsedPct)}
                ceiling={ceilings ? `${ceilings.swapUsedPct} %` : undefined}
                swatch={SWAP_MARK}
                small
                label="swap"
              />
            </>
          }
        >
          <TimeChart
            name="Memory and swap"
            times={times}
            series={[memory, swap]}
            reference={ceilings?.swapUsedPct}
            format={percent}
            onActiveChange={setHover}
          />
        </ChartRow>
        <ChartRow
          title="Swapped out"
          span={span}
          when={when}
          hovering={hovering}
          figures={
            <Figure
              value={shown?.swapoutMbPer300s == null ? '-' : mebibytes(shown.swapoutMbPer300s)}
              ceiling={ceilings?.swapoutMbPer300s.toLocaleString('en-GB')}
            />
          }
        >
          <TimeChart
            name="Swapped out"
            times={times}
            series={[
              {
                name: 'Swapped out',
                values: column((s) => s.swapoutMbPer300s),
                tone: 'neutral',
                mark: INK_MARK,
                area: true,
              },
            ]}
            reference={ceilings?.swapoutMbPer300s}
            format={mebibytes}
            onActiveChange={setHover}
          />
        </ChartRow>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 min-[36rem]:grid-cols-2">
        <Processes title="Top by CPU" rows={host.topByCpu} value={(p) => `${oneDecimal(p.cpuPct)} %`} />
        <Processes title="Top by memory" rows={host.topByMemory} value={(p) => mebibytes(p.memoryMb)} />
      </div>
    </>
  )
}
