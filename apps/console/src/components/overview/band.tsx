import type { FlowModel } from '@software-factory/contract'
import { CheckCircleIcon, CpuIcon, type Icon, LightningIcon, SirenIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Age } from '@/components/kit/issue-parts'
import { TONE_MARK, TONE_TEXT, type Tone } from '@/components/kit/tone'
import type { KIND_LABEL } from '@/lib/needs'
import { needsOf, productionOf, type ProjectCount, queueBindingOf, regressedOf, shippedOf } from '@/lib/overview'
import { useHost, useMachine, useNeeds, useProjectIndex } from '@/lib/queries'
import { hostMeters } from '@/lib/strip'
import { cn } from '@/lib/utils'

const LINK =
  'rounded-sm outline-none underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50'

/** A singular need kind for one line ("Decision"), from the plural label of Needs you. */
const KIND_ONE: Record<keyof typeof KIND_LABEL, string> = {
  decision: 'Decision',
  review: 'Review',
  errand: 'Errand',
  held_signal: 'Quarantined signal',
  long_wait: 'Long wait',
}

/** The status lamp: lit in a tone only for something live; a neutral panel has none. */
function Lamp({ tone }: { tone: Tone }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: TONE_MARK[tone] }} />
}

/** One panel of the band: an icon tile, a title that links to where the detail lives, the figure, then its lines. */
function Panel({
  icon: PanelIcon,
  title,
  to,
  figure,
  figureLabel,
  tone,
  children,
  testId,
}: {
  icon: Icon
  title: string
  to: '/needs-you' | '/projects' | '/throughput'
  figure: ReactNode
  figureLabel: string
  tone: Tone
  children: ReactNode
  testId: string
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="flex min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground"
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex items-center gap-2 px-2.5 pt-2 pb-1">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <PanelIcon className="size-3.5 text-muted-foreground" aria-hidden />
        </span>
        <Link to={to} className={cn(LINK, 'text-[13px] font-medium text-muted-foreground')}>
          {title}
        </Link>
        <span className="ml-auto flex items-center gap-1.5">{tone === 'neutral' ? null : <Lamp tone={tone} />}</span>
      </header>
      <div className="flex flex-1 md:min-h-36 flex-col gap-2 rounded-lg bg-background px-3 py-2.5">
        <p className="flex items-baseline gap-2">
          <span className={cn('font-heading text-2xl font-semibold tabular-nums', TONE_TEXT[tone])}>{figure}</span>
          <span className="text-[13px] text-muted-foreground">{figureLabel}</span>
        </p>
        {children}
      </div>
    </section>
  )
}

/** Projects with their count, each a link to its page; past five the rest are a count. */
function ProjectList({ rows, unit, empty }: { rows: readonly ProjectCount[]; unit: string; empty: string }) {
  if (rows.length === 0) return <p className="text-[13px] text-muted-foreground">{empty}</p>
  const shown = rows.slice(0, 5)
  return (
    <ul className="flex flex-col gap-1 text-[13px]">
      {shown.map((row) => (
        <li key={row.project} className="flex items-center gap-2">
          <Link
            to="/projects/$name"
            params={{ name: row.project }}
            data-keynav=""
            className={cn(LINK, 'min-w-0 flex-1 truncate')}
          >
            {row.project}
          </Link>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {row.count} {unit}
          </span>
        </li>
      ))}
      {rows.length > shown.length ? (
        <li className="text-xs text-muted-foreground">{rows.length - shown.length} more projects</li>
      ) : null}
    </ul>
  )
}

function NeedsPanel({ now }: { now: number }) {
  const { data } = useNeeds()
  if (!data)
    return (
      <Panel
        icon={LightningIcon}
        title="Needs you"
        to="/needs-you"
        figure="-"
        figureLabel="not read yet"
        tone="neutral"
        testId="overview-needs"
      >
        <span />
      </Panel>
    )
  const { total, top } = needsOf(data)
  return (
    <Panel
      icon={LightningIcon}
      title="Needs you"
      to="/needs-you"
      figure={total}
      figureLabel={total === 1 ? 'thing wants you' : 'things want you'}
      tone={total > 0 ? 'accent' : 'neutral'}
      testId="overview-needs"
    >
      {top.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing wants your answer, your review or your hands.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {top.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="flex min-w-0 flex-col">
              <Link
                to="/needs-you"
                search={{ item: item.id }}
                data-keynav=""
                className={cn(LINK, 'line-clamp-1 text-[13px] font-medium')}
                title={item.title}
              >
                {item.title}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {KIND_ONE[item.kind]}
                {item.repo ? <span className="truncate">{item.repo}</span> : null}
                <Age since={item.since} now={now} className="ml-auto" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function ProductionPanel({ data }: { data: FlowModel }) {
  const { red, checking } = productionOf(data)
  const checks = checking.reduce((sum, row) => sum + row.count, 0)
  const index = useProjectIndex().data
  const regressed = index ? regressedOf(index.projects) : []
  return (
    <Panel
      icon={SirenIcon}
      title="Production"
      to="/projects"
      figure={red.length}
      figureLabel={red.length === 1 ? 'project red' : 'projects red'}
      tone={red.length > 0 ? 'bad' : regressed.length > 0 ? 'warn' : 'good'}
      testId="overview-production"
    >
      <ProjectList rows={red} unit="incident" empty="No open incident in any project." />
      {regressed.length > 0 ? (
        <p className={cn('text-[13px]', TONE_TEXT.warn)} data-testid="overview-regressed">
          Regressed in 7 days:{' '}
          {regressed.map((row, i) => (
            <span key={row.project}>
              {i > 0 ? ', ' : null}
              <Link to="/projects/$name" params={{ name: row.project }} className={LINK}>
                {row.project}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      <p className="mt-auto text-xs text-muted-foreground">
        {checks === 0
          ? 'No ship is being checked in production.'
          : `${checks} ${checks === 1 ? 'ship' : 'ships'} Checking in ${checking.length} ${checking.length === 1 ? 'project' : 'projects'}.`}
      </p>
    </Panel>
  )
}

function ShippedPanel({ data }: { data: FlowModel }) {
  const { total, byProject } = shippedOf(data)
  return (
    <Panel
      icon={CheckCircleIcon}
      title="Shipped in 24 h"
      to="/projects"
      figure={total}
      figureLabel={total === 1 ? 'Issue shipped' : 'Issues shipped'}
      tone={total > 0 ? 'good' : 'neutral'}
      testId="overview-shipped"
    >
      <ProjectList rows={byProject} unit="shipped" empty="Nothing shipped in the last 24 hours." />
    </Panel>
  )
}

function HostPanel({ data }: { data: FlowModel }) {
  const machine = useMachine().data
  const host = useHost().data
  const meters = hostMeters(machine, host?.samples[host.samples.length - 1])
  const worst: Tone = meters.some((m) => m.tone === 'bad')
    ? 'bad'
    : meters.some((m) => m.tone === 'warn')
      ? 'warn'
      : 'neutral'
  const queue = queueBindingOf(data)
  return (
    <Panel
      icon={CpuIcon}
      title="Host and queue"
      to="/throughput"
      figure={queue.notStarted}
      figureLabel="not started"
      tone={worst}
      testId="overview-host"
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]" data-testid="overview-host-line">
        {meters.map((meter) => (
          <span key={meter.key} className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">{meter.label}</span>
            <span className={cn('tabular-nums', meter.tone !== 'neutral' && TONE_TEXT[meter.tone])}>{meter.text}</span>
          </span>
        ))}
      </p>
      <p className="text-[13px]" data-testid="overview-queue">
        {queue.binding ? (
          <>
            <span className="font-medium">{queue.binding.words}</span>
            <span className="text-muted-foreground">
              {' '}
              keeps {queue.binding.count} of {queue.notStarted} out
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Nothing keeps a not-started Issue out; each starts at its turn.</span>
        )}
      </p>
      {queue.binding?.message ? (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={queue.binding.message}>
          {queue.binding.message}
        </p>
      ) : null}
      {queue.state ? (
        <p className={cn('mt-auto text-xs', TONE_TEXT.warn)}>
          The queue is set to {queue.state === 'pace' ? 'pace' : 'drain'}.
        </p>
      ) : null}
    </Panel>
  )
}

/**
 * The top of the Overview, read left to right: what wants the owner, whether production is red, what shipped, and the
 * host with the queue's binding reason. Each panel links to the screen that holds its detail.
 */
export function OverviewBand({ data, now }: { data: FlowModel; now: number }) {
  return (
    <div
      role="group"
      aria-label="At a glance"
      data-testid="overview-band"
      className="mb-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-4"
    >
      <NeedsPanel now={now} />
      <ProductionPanel data={data} />
      <ShippedPanel data={data} />
      <HostPanel data={data} />
    </div>
  )
}
