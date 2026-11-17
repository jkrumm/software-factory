import { CheckCircleIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { PlanRowView, ProjectPageModel } from '@software-factory/contract'
import { useIsPeeked } from '@/components/peek/use-peeked'
import { EmptyState, InfoHint, type InfoWord, Lozenge, Section, Skeleton, StatCard } from '@/components/kit'
import { Age, IssueNumber, ReasonLine } from '@/components/kit/issue-parts'
import { KindIcon } from '@/components/kit/kind-badge'
import { TONE_MARK } from '@/components/kit/tone'
import type { FlowCard } from '@/lib/flow'
import { cardsOf } from '@/lib/flow'
import { dayLabels, FIRST_SCREEN_ROWS, firstRows, healthOf, ownsCard, upcomingRows } from '@/lib/project'
import { useMediaQuery } from '@/lib/media'
import { useNow } from '@/lib/now'
import { useFlow, useProjectHygiene, useProjectPage, useProjectPlan } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { ItemRow } from './activity'
import { LINK, None } from './parts'
import { ScreenLink } from './tab-link'

const HOUR_MS = 3_600_000

/** The answers to "is it healthy": a lamp and one sentence each, every one a link to the tab that has the detail. */
function HealthBand({ name, cells }: { name: string; cells: ReturnType<typeof healthOf> }) {
  return (
    <ul aria-label="Health" className="grid gap-3 min-[40rem]:grid-cols-3">
      {cells.map((cell) => (
        <li key={cell.key} className="min-w-0">
          <ScreenLink
            name={name}
            screen={cell.tab}
            className="flex h-full min-w-0 items-start gap-3 rounded-xl bg-card px-4 py-3 outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden="true"
              data-tone={cell.tone}
              className="mt-1.5 size-2 shrink-0 rounded-full"
              style={{ background: TONE_MARK[cell.tone] }}
            />
            <span className="min-w-0">
              <span className="block text-[length:var(--vx-text-sm)] font-medium">{cell.label}</span>
              <span className="line-clamp-2 text-[length:var(--vx-text-sm)] text-muted-foreground" title={cell.text}>
                {cell.text}
              </span>
            </span>
          </ScreenLink>
        </li>
      ))}
    </ul>
  )
}

/** One open Issue as a line of its own column: kind, number, title, how long it has been in its state, and why it waits when it does. */
function OpenRow({ card, now }: { card: FlowCard; now: number }) {
  const selected = useIsPeeked(card.number)
  return (
    <li
      aria-current={selected ? 'true' : undefined}
      className={cn('min-w-0 rounded-md px-1.5 py-1 transition-colors hover:bg-accent', selected && 'bg-accent')}
    >
      <Link
        to="/issues/$id"
        params={{ id: String(card.number) }}
        className="grid min-w-0 grid-cols-[1.25rem_2.75rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm text-[length:var(--vx-text-sm)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <KindIcon kind={card.kind} />
        <IssueNumber number={card.number} />
        <span className="truncate font-medium">{card.title}</span>
        <Age since={card.since} now={now} />
        {card.reason ? (
          <ReasonLine
            state={card.state}
            reason={card.reason}
            className="col-start-3 col-end-5 text-xs [&>span]:line-clamp-1"
          />
        ) : null}
      </Link>
    </li>
  )
}

/** The first rows of one state with the count behind them; the rest are one click away in Work. */
function OpenList({
  name,
  title,
  hint,
  cards,
  empty,
  now,
}: {
  name: string
  title: string
  hint: InfoWord
  cards: readonly FlowCard[]
  empty: string
  now: number
}) {
  const { shown, more } = firstRows(cards)
  return (
    <div className="min-w-0">
      <h3 className="mb-1 flex items-center gap-1 text-[length:var(--vx-text-sm)] font-medium text-muted-foreground">
        {title}
        <InfoHint word={hint} />
        <span className="tabular-nums">{cards.length}</span>
      </h3>
      {shown.length === 0 ? (
        <None>{empty}</None>
      ) : (
        <ul aria-label={title} className="grid">
          {shown.map((card) => (
            <OpenRow key={card.key} card={card} now={now} />
          ))}
        </ul>
      )}
      {more > 0 ? (
        <ScreenLink
          name={name}
          screen="work"
          className={cn(LINK, 'mt-1 inline-block px-1.5 text-xs text-muted-foreground')}
        >
          {more} more in Work
        </ScreenLink>
      ) : null}
    </div>
  )
}

const PLAN_TONE = { filable: 'good', waiting: 'warn' } as const

/** The rows of the plan no Issue is on yet. */
function UpcomingRows({ name, rows }: { name: string; rows: readonly PlanRowView[] }) {
  const { shown, more } = firstRows(rows)
  return (
    <div className="min-w-0">
      <h3 className="mb-1 flex items-center gap-1 text-[length:var(--vx-text-sm)] font-medium text-muted-foreground">
        Planned
        <InfoHint word="plan" />
        <span className="tabular-nums">{rows.length}</span>
      </h3>
      {shown.length === 0 ? (
        <None>No plan row waits to be filed.</None>
      ) : (
        <ul aria-label="Next plan rows" className="grid">
          {shown.map((row) => (
            <li
              key={row.key}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-1 text-[length:var(--vx-text-sm)]"
            >
              <span className="truncate font-medium">{row.title ?? row.key}</span>
              <Lozenge tone={row.state === 'filable' ? PLAN_TONE.filable : PLAN_TONE.waiting}>
                {row.state === 'filable' ? 'May file' : 'Waits'}
              </Lozenge>
              {row.reason ? (
                <span className="col-span-2 line-clamp-1 text-xs text-muted-foreground" title={row.reason}>
                  {row.reason}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? (
        <ScreenLink
          name={name}
          screen="plan"
          className={cn(LINK, 'mt-1 inline-block px-1.5 text-xs text-muted-foreground')}
        >
          {more} more in Plan
        </ScreenLink>
      ) : null}
    </div>
  )
}

/** The hourly bars of the last 7 days with the newest five shipped; the history is the Shipped tab. */
export function ShippedPanel({
  name,
  page,
  now,
  side,
}: {
  name: string
  page: ProjectPageModel
  now: number
  side: 'right' | 'bottom'
}) {
  const { shipped } = page
  const total = shipped.days.reduce((sum, n) => sum + n, 0)
  const days = dayLabels(page.at)
  const end = Date.parse(page.at)
  const hourLabels = shipped.hours.map(
    (count, i) =>
      `${new Date(end - (shipped.hours.length - 1 - i) * HOUR_MS).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}: ${count} shipped`,
  )
  const newest = shipped.items.slice(0, FIRST_SCREEN_ROWS)
  return (
    <div className="grid min-w-0 content-start gap-4">
      <StatCard
        icon={CheckCircleIcon}
        title="Issues per hour"
        subtitle="Last 7 days, against the 7 days before"
        value={total}
        delta={{ value: total - shipped.before, higherIsBetter: true }}
        bars={shipped.hours}
        barLabels={hourLabels}
        xLabels={[days[0] ?? '', days[3] ?? '', 'Now']}
        footer={[
          { label: 'Before', value: String(shipped.before) },
          { label: 'Busiest day', value: String(Math.max(...shipped.days)) },
        ]}
        as={(props) => <Link to="/projects/$name/shipped" params={{ name }} {...props} />}
      />
      {newest.length === 0 ? (
        <None>Nothing shipped in the last 7 days.</None>
      ) : (
        <ul aria-label="Newest shipped" className="grid">
          {newest.map((item) => (
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
      {shipped.items.length > newest.length ? (
        <ScreenLink
          name={name}
          screen="shipped"
          className={cn(LINK, 'inline-block px-1.5 text-xs text-muted-foreground')}
        >
          {shipped.items.length - newest.length} more shipped in the last 7 days
        </ScreenLink>
      ) : null}
    </div>
  )
}

/**
 * The first screen, read top-down at 1800 by 1200 with no scrolling: is it healthy (production, the checks, the project's
 * files), what moves now (Running and Paused with the reason, five each), what is next (Ready, Held and the plan's next
 * rows) and what shipped. Each list ends in a count that opens the tab with the rest, and nothing is told twice.
 */
export function Overview({ name }: { name: string }) {
  const page = useProjectPage(name)
  const plan = useProjectPlan(name)
  const hygiene = useProjectHygiene(name)
  const flow = useFlow()
  const now = useNow(30_000)
  const wide = useMediaQuery('(min-width: 768px)')
  if (!page.data) return null
  const model = page.data
  const cells = healthOf({ page: model, hygiene: hygiene.data, plan: plan.data, now })
  const open = flow.data ? cardsOf(flow.data) : null
  const mine = (cards: FlowCard[] | undefined) => (cards ?? []).filter((card) => ownsCard(model, card.repo))
  const upcoming = plan.data ? upcomingRows(plan.data.rows) : null
  return (
    <div className="grid gap-8">
      <HealthBand name={name} cells={cells} />
      <div className="grid gap-x-8 gap-y-8 xl:grid-cols-3">
        <Section title="Moving now">
          {open ? (
            <div className="grid gap-5">
              <OpenList
                name={name}
                title="Running"
                hint="running"
                cards={mine(open.running)}
                empty="Nothing runs."
                now={now}
              />
              <OpenList
                name={name}
                title="Paused"
                hint="paused"
                cards={mine(open.paused)}
                empty="Nothing is paused."
                now={now}
              />
            </div>
          ) : (
            <Skeleton height={320} rounded="rounded-xl" />
          )}
        </Section>
        <Section title="Next">
          {open && upcoming ? (
            <div className="grid gap-5">
              <OpenList
                name={name}
                title="Ready"
                hint="ready"
                cards={mine(open.ready)}
                empty="Nothing waits for a seat."
                now={now}
              />
              <OpenList
                name={name}
                title="Held"
                hint="held"
                cards={mine(open.held)}
                empty="Nothing is held back."
                now={now}
              />
              <UpcomingRows name={name} rows={upcoming} />
            </div>
          ) : open && plan.isError ? (
            <EmptyState title="The plan did not load">Ready and held Issues are in Work.</EmptyState>
          ) : (
            <Skeleton height={320} rounded="rounded-xl" />
          )}
        </Section>
        <Section title="Shipped">
          <ShippedPanel name={name} page={model} now={now} side={wide ? 'right' : 'bottom'} />
        </Section>
      </div>
    </div>
  )
}
