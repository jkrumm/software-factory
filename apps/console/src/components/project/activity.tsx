import { CheckCircleIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { FlowModel, PlanRowView, ProjectPageModel } from '@software-factory/contract'
import { FlowCardView } from '@/components/flow/card'
import { Ago } from '@/components/issue/ago'
import { EmptyState, Fold, Lozenge, Section, SinceRow, type SinceRowProps } from '@/components/kit'
import type { Tone } from '@/components/kit/tone'
import { cardsOf, numberOf, type StateKey } from '@/lib/flow'
import { nextRows, planSummary } from '@/lib/project'
import { cn } from '@/lib/utils'
import { LINK, Mono, None, NUM, Table, TD, TH } from './parts'

const POPOVER_LINK =
  'inline-flex items-center gap-1 rounded-sm text-[length:var(--vx-text-sm)] underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/** The open states in the order the owner reads them: what runs, what waits for something, what has not started. */
const OPEN_ORDER: readonly StateKey[] = ['working', 'watching', 'waiting', 'queued', 'settling']

/** The project's Issues as the Flow cards: a card names its project by name, or by the repo's path when the name was taken by another directory. */
const ownsCard = (project: { name: string; repo: string }, repo: string): boolean =>
  repo === project.name || repo === project.repo || repo.startsWith(`${project.repo}/`)

/** What runs now and what waits, from the cached Flow read so the stream keeps it current. */
export function NowSection({
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
  return (
    <Section title="Now" aside={`${cards.length} open`} className="min-w-0">
      {cards.length === 0 ? (
        <EmptyState title="Nothing is open">Working, waiting and queued Issues of this project show here.</EmptyState>
      ) : (
        <ul aria-label="Open Issues" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {cards.map((card) => (
            <li key={card.key} className="min-w-0">
              <FlowCardView card={card} now={now} showState />
            </li>
          ))}
        </ul>
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

/** One compact row per Issue: its popover carries the full title and the link. */
function ItemRow({
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

/** The Issues that shipped in the last 7 days. */
export function ShippedSection({
  page,
  now,
  side,
}: { page: ProjectPageModel; now: number } & Pick<SinceRowProps, 'side'>) {
  const { items } = page.shipped
  return (
    <Section title="Shipped, last 7 days" aside={`${items.length} newest`} className="min-w-0">
      {items.length === 0 ? (
        <None>Nothing shipped in the last 7 days.</None>
      ) : (
        <ul className="grid">
          {items.map((item) => (
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
const PLAN_ROWS = 12

/** The plan: how many rows are done, and the rows that come next. */
export function PlanSection({
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
  const next = nextRows(rows)
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
          The plan on the default branch does not parse; the rows are the last valid plan's. {error}
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
          <p className="mb-3 text-[length:var(--vx-text-sm)] text-muted-foreground tabular-nums">
            {summary.done} of {summary.total} rows done, {summary.open} in flight, {summary.filable} may file now,{' '}
            {summary.waiting} wait.
          </p>
          {next.length === 0 ? (
            <None>Every row is done.</None>
          ) : (
            <Table
              label="Next plan rows"
              head={
                <>
                  <th className={TH}>Row</th>
                  <th className={TH}>State</th>
                  <th className={TH}>Why</th>
                </>
              }
            >
              {next.slice(0, PLAN_ROWS).map((row) => (
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
                </tr>
              ))}
            </Table>
          )}
          {next.length > PLAN_ROWS ? (
            <Fold title="More rows" count={next.length - PLAN_ROWS} className="mt-3">
              <ul className="grid gap-1 pt-3 text-[length:var(--vx-text-sm)]">
                {next.slice(PLAN_ROWS).map((row) => (
                  <li key={row.key} className="flex gap-3">
                    <Mono className="text-muted-foreground">{row.key}</Mono>
                    <span className="min-w-0 wrap-anywhere">{row.title ?? row.key}</span>
                  </li>
                ))}
              </ul>
            </Fold>
          ) : null}
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

/** Production as the factory knows it: what it watches, what alerted, what regressed, and the monitors that file alerts here. */
export function ProductionSection({ page, now }: { page: ProjectPageModel; now: number }) {
  const { production } = page
  return (
    <Section title="Production" hint="watch">
      <div className="grid gap-6 md:grid-cols-3">
        <IssueList
          label="In Watch"
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
      <h3 className="mt-6 mb-2 text-sm font-medium text-muted-foreground">
        Monitors that file alerts here <span className="tabular-nums">{production.monitors.length}</span>
      </h3>
      {production.monitors.length === 0 ? (
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
          {production.monitors.map((monitor) => (
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
