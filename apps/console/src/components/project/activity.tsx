import { CheckCircleIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { FlowModel, PlanRowView, ProjectPageModel } from '@software-factory/contract'
import { Ago } from '@/components/issue/ago'
import { EmptyState, Lozenge, Section, SinceRow, type SinceRowProps } from '@/components/kit'
import { IssueTable } from '@/components/flow/issue-table'
import { MeterBar } from '@/components/kit/meter'
import type { Tone } from '@/components/kit/tone'
import {
  cardsOf,
  defaultSort,
  numberOf,
  type Sort,
  type SortKey,
  sortedCards,
  startSort,
  type StateKey,
} from '@/lib/flow'
import { ownsCard, planSummary } from '@/lib/project'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { LINK, Mono, None, NUM, Table, TD, TH } from './parts'

/** The open words in the order the owner reads them: what runs, what waits for something, what has not started. */
const OPEN_ORDER: readonly StateKey[] = ['running', 'checking', 'paused', 'ready', 'held']

const POPOVER_LINK =
  'inline-flex items-center gap-1 rounded-sm text-[length:var(--vx-text-sm)] underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/** Work: every open Issue of the project, sortable by the pressed column. From the cached Flow read, so the stream keeps it current. */
export function WorkList({
  project,
  flow,
  now,
}: {
  project: { name: string; repo: string }
  flow: FlowModel
  now: number
}) {
  const byState = cardsOf(flow)
  const cards = OPEN_ORDER.flatMap((key) => byState[key]).filter((card) => ownsCard(project, card.repo))
  const [picked, setPicked] = useState<Sort | null>(null)
  const sort = picked ?? defaultSort()
  const onSort = (key: SortKey) =>
    setPicked(sort.key === key ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' } : startSort(key))
  return (
    <Section title="Open Issues" aside={`${cards.length} open`} className="min-w-0">
      {cards.length === 0 ? (
        <EmptyState title="Nothing is open">
          Running, paused, ready, held and checking Issues of this project show here.
        </EmptyState>
      ) : (
        <IssueTable label="Open Issues" cards={sortedCards(cards, sort)} sort={sort} onSort={onSort} now={now} />
      )}
    </Section>
  )
}

type Item = { id: string; title: string; kind: string }

function IssueLinks({ id }: { id: string }) {
  return (
    <Link to="/issues/$id" params={{ id: String(numberOf(id)) }} className={POPOVER_LINK}>
      Open the Issue
    </Link>
  )
}

/** One compact row per shipped Issue: its popover carries the full title and the link. */
export function ItemRow({
  item,
  at,
  happened,
  outcome,
  tone,
  project,
  now,
  side,
}: { item: Item; at: string; happened: string; outcome: string; tone: Tone; project: string; now: number } & Pick<
  SinceRowProps,
  'side'
>) {
  return (
    <li className="min-w-0">
      <SinceRow
        icon={CheckCircleIcon}
        tone={tone}
        outcome={outcome}
        happened={happened}
        title={item.title}
        number={String(numberOf(item.id))}
        project={project}
        at={at}
        now={now}
        side={side}
      >
        <IssueLinks id={item.id} />
      </SinceRow>
    </li>
  )
}

/** What shipped in the last 7 days, newest first, grouped by day. */
export function ShippedHistory({
  page,
  now,
  side,
}: { page: ProjectPageModel; now: number } & Pick<SinceRowProps, 'side'>) {
  const { items } = page.shipped
  const days = new Map<string, typeof items>()
  for (const item of items) {
    const day = new Date(item.closedAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    days.set(day, [...(days.get(day) ?? []), item])
  }
  return (
    <Section title="Shipped, last 7 days" aside={`${items.length} Issues`} className="min-w-0">
      {items.length === 0 ? (
        <None>Nothing shipped in the last 7 days.</None>
      ) : (
        <div className="grid gap-5">
          {[...days].map(([day, rows]) => (
            <div key={day} className="min-w-0">
              <h3 className="mb-1 text-[length:var(--vx-text-sm)] font-medium text-muted-foreground">
                {day} <span className="tabular-nums">{rows.length}</span>
              </h3>
              <ul className="grid">
                {rows.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    at={item.closedAt}
                    happened={`Closed ${item.outcome}.`}
                    outcome={item.outcome === 'healed' ? 'Healed' : 'Shipped'}
                    tone="good"
                    project={page.name}
                    now={now}
                    side={side}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

const ROW_TONE: Record<PlanRowView['state'], Tone> = { done: 'good', open: 'accent', filable: 'good', waiting: 'warn' }
const ROW_WORDS: Record<PlanRowView['state'], string> = {
  done: 'Done',
  open: 'In flight',
  filable: 'May file',
  waiting: 'Waits',
}
const ROW_ORDER: Record<PlanRowView['state'], number> = { open: 0, filable: 1, waiting: 2, done: 3 }

/** The plan: how far it is, and every row with its state and why, the rows in flight first and the finished ones last. */
export function PlanTable({
  project,
  rows,
  error,
  warnings,
}: {
  project: string
  rows: readonly PlanRowView[]
  error: string | null
  warnings: readonly string[]
}) {
  const summary = planSummary(rows)
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => ROW_ORDER[a.row.state] - ROW_ORDER[b.row.state] || a.index - b.index)
    .map(({ row }) => row)
  return (
    <Section
      title="Plan"
      hint="plan"
      aside={
        <Link to="/chain" search={{ project }} className={LINK}>
          Open in Chain
        </Link>
      }
    >
      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-[color-mix(in_srgb,var(--vx-bad-solid)_12%,transparent)] px-3 py-2 text-[length:var(--vx-text-sm)] text-[color:var(--vx-bad-text)]"
        >
          The plan on the default branch does not parse; the rows are the last valid plan&rsquo;s. {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="mb-3 grid gap-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {summary.total === 0 ? (
        <None>This project has no plan rows.</None>
      ) : (
        <>
          <div className="mb-4 grid gap-2">
            <MeterBar value={(summary.done ?? 0) / summary.total} tone="good" />
            <p className="text-[length:var(--vx-text-sm)] text-muted-foreground tabular-nums">
              {summary.done} of {summary.total} rows done ({summary.percent}%), {summary.open} in flight,{' '}
              {summary.filable} may file now, {summary.waiting} wait.
            </p>
          </div>
          <Table
            label="Plan rows"
            head={
              <>
                <th className={TH}>Row</th>
                <th className={TH}>State</th>
                <th className={TH}>Why</th>
                <th className={cn(TH, NUM)}>Waits for</th>
              </>
            }
          >
            {ordered.map((row) => (
              <tr key={row.key}>
                <td className={cn(TD, 'min-w-0')}>
                  {row.issue ? (
                    <Link to="/issues/$id" params={{ id: String(numberOf(row.issue)) }} className={LINK}>
                      {row.title ?? row.key}
                    </Link>
                  ) : (
                    <span>{row.title ?? row.key}</span>
                  )}
                  <div>
                    <Mono className="text-muted-foreground">{row.key}</Mono>
                  </div>
                </td>
                <td className={TD}>
                  <Lozenge tone={ROW_TONE[row.state]}>{ROW_WORDS[row.state]}</Lozenge>
                </td>
                <td className={cn(TD, 'text-muted-foreground')}>{row.reason ?? ''}</td>
                <td className={cn(TD, NUM, 'text-muted-foreground')}>
                  {row.after.length === 0 ? '' : row.after.join(', ')}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Section>
  )
}

function IssueList({
  label,
  items,
  empty,
  now,
}: {
  label: string
  items: (Item & { at: string; note?: string })[]
  empty: string
  now: number
}) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">
        {label} <span className="tabular-nums">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <None>{empty}</None>
      ) : (
        <ul className="grid gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 items-baseline gap-2 text-[length:var(--vx-text-sm)]">
              <Link
                to="/issues/$id"
                params={{ id: String(numberOf(item.id)) }}
                className={cn(LINK, 'min-w-0 wrap-anywhere')}
              >
                {item.title}
              </Link>
              {item.note ? <span className="shrink-0 text-xs text-muted-foreground">{item.note}</span> : null}
              <Ago iso={item.at} now={now} className="ml-auto shrink-0 text-xs text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Production as the factory knows it: what it watches, what alerted and what regressed. */
export function ProductionSection({ page, now }: { page: ProjectPageModel; now: number }) {
  const { production } = page
  return (
    <Section title="Production" hint="watch">
      <div className="grid gap-6 md:grid-cols-3">
        <IssueList
          label="Checking in Watch"
          items={production.watching.map((i) => ({ ...i, at: i.since }))}
          empty="Nothing is being watched."
          now={now}
        />
        <IssueList
          label="Incidents, last 7 days"
          items={production.incidents.map((i) => ({ ...i, at: i.openedAt, note: i.open ? 'open' : 'closed' }))}
          empty="No incident."
          now={now}
        />
        <IssueList
          label="Regressions, last 7 days"
          items={production.regressions}
          empty="Nothing regressed."
          now={now}
        />
      </div>
    </Section>
  )
}

/** The monitors (Uptime Kuma, ClickStack) whose alerts the door files in this project, with the last thing each said. */
export function MonitorsSection({ page }: { page: ProjectPageModel }) {
  const { monitors } = page.production
  return (
    <Section title="Monitors" aside={`${monitors.length} file alerts here`}>
      {monitors.length === 0 ? (
        <None>No monitor routes its alerts to this project.</None>
      ) : (
        <Table
          label="Monitors"
          head={
            <>
              <th className={TH}>Source</th>
              <th className={TH}>Monitor</th>
              <th className={TH}>Last event</th>
              <th className={cn(TH, NUM)}>Quiet alerts</th>
            </>
          }
        >
          {monitors.map((monitor) => (
            <tr key={`${monitor.source}/${monitor.monitor}`}>
              <td className={TD}>
                <Mono>{monitor.source}</Mono>
              </td>
              <td className={TD}>{monitor.monitor}</td>
              <td className={cn(TD, 'text-muted-foreground')}>{monitor.lastEvent ?? 'None yet'}</td>
              <td className={cn(TD, NUM)}>{monitor.quiet}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}
