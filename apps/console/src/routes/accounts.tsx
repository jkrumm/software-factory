import type { AccountRow, AccountsView } from '@software-factory/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { EmptyState, Lozenge, Meter, Section, Skeleton } from '@/components/kit'
import { MiniBars } from '@/components/kit/mini-bars'
import type { Tone } from '@/components/kit/tone'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Page, PageHeader } from '@/components/page'
import { AccountsSkeleton } from '@/components/skeletons'
import { clearAccountMode, setAccountMode } from '@/lib/api'
import {
  defaultHoldModel,
  EXPIRIES,
  forecastWords,
  type Intent,
  INTENT_LABELS,
  intentBody,
  laneOrder,
  ledgerBars,
  limitsOf,
  MODE_TONES,
  modeLabel,
  modeSource,
  modeUntil,
  quotaWeeks,
} from '@/lib/accounts'
import { meterTone } from '@/components/kit/tone'
import { useNow } from '@/lib/now'
import { useAccounts, useKpis } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'
import { resetWords } from '@/lib/strip'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/accounts')({
  /** `lane` is one of the lanes the package answers for; a missing one is the bulk lane, where leads start. */
  validateSearch: (search: Record<string, unknown>): { lane?: string } =>
    typeof search.lane === 'string' && search.lane !== '' && search.lane !== 'bulk' ? { lane: search.lane } : {},
  component: Accounts,
})

const DEFAULT_LANE = 'bulk'

/** The shell holds the header; the body sits one surface step below it, as a StatCard's does. */
const SHELL = 'rounded-xl bg-card p-1 text-card-foreground'
const INSET = 'rounded-lg bg-background px-4 py-3.5'

/** The accounts' mode as a Lozenge, with when it ends beside it. */
function ModeBadge({ account, now }: { account: AccountRow; now: Date }) {
  const { mode } = account
  const tone: Tone = MODE_TONES[mode.kind]
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Lozenge tone={tone}>{modeLabel(mode)}</Lozenge>
      {mode.kind === 'normal' ? null : (
        <span className="text-[length:var(--vx-text-sm)] text-muted-foreground">
          {modeUntil(mode, now)} · {modeSource(mode)}
        </span>
      )}
    </span>
  )
}

/** The order the lane gives accounts now, with the rule's reason for each place. */
function OrderNow({ view, lane }: { view: AccountsView; lane: string }) {
  const entries = laneOrder(view, lane)
  return (
    <ol aria-label={`Order in the ${lane} lane`} className="flex flex-wrap gap-2">
      {entries.map((entry) => (
        <li
          key={entry.account}
          data-open={entry.open}
          className={cn(
            'flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-[length:var(--vx-text-sm)]',
            !entry.open && 'text-muted-foreground',
          )}
        >
          <span className="font-mono tabular-nums text-muted-foreground">{entry.open ? entry.position : '–'}</span>
          <span className="font-medium text-foreground">{entry.account}</span>
          <span>{entry.open ? entry.words : `closed: ${entry.words ?? 'no reason given'}`}</span>
        </li>
      ))}
    </ol>
  )
}

function LaneSwitch({ lanes, lane }: { lanes: string[]; lane: string }) {
  return (
    <nav aria-label="Lane" className="flex flex-wrap gap-2">
      {lanes.map((choice) => (
        <Link
          key={choice}
          to="/accounts"
          search={choice === DEFAULT_LANE ? {} : { lane: choice }}
          aria-current={choice === lane ? 'page' : undefined}
          className={buttonVariants({ variant: choice === lane ? 'secondary' : 'outline', size: 'sm' })}
        >
          {choice}
        </Link>
      ))}
    </nav>
  )
}

/** Quota used at reset: the KPI's last weekly windows, from the KPI model; nothing is weighted here. */
function Score() {
  const kpis = useKpis(7)
  const kpi = kpis.data?.kpis.find((k) => k.key === 'quota_at_reset')
  if (!kpi) return <Skeleton height={96} rounded="rounded-xl" />
  const { values, labels } = quotaWeeks(kpi)
  const value = kpi.value === null ? null : Math.round(kpi.value * 100)
  return (
    <div className={SHELL}>
      <div className={cn(INSET, 'grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-end')}>
        <div>
          <p className="text-[length:var(--vx-text-display)] leading-none font-semibold tracking-tight tabular-nums">
            {value === null ? '–' : `${value} %`}
          </p>
          <p className="mt-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground">
            {value === null
              ? (kpi.reason ?? 'No reset in the window')
              : 'of the week used at the reset, over the last 7 days'}
          </p>
        </div>
        {kpi.history.every((point) => point.value === null) ? null : (
          <MiniBars
            name="Quota used at reset, per week"
            values={values}
            labels={labels}
            format={(v) => `${v} %`}
            height={56}
          />
        )}
      </div>
    </div>
  )
}

function Limits({ account, now }: { account: AccountRow; now: Date }) {
  const limits = limitsOf(account)
  if (limits.length === 0)
    return <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">No reading yet</p>
  return (
    <div className="grid gap-1.5">
      {limits.map((limit) => (
        <div key={`${limit.key}-${limit.label}`} className="flex items-center gap-3">
          {limit.percent === null ? (
            <>
              <span className="w-28 shrink-0 text-[length:var(--vx-text-sm)] text-muted-foreground">{limit.label}</span>
              <span className="flex-1 text-muted-foreground">–</span>
            </>
          ) : (
            <Meter
              className="flex-1"
              label={limit.label}
              value={limit.percent / 100}
              tone={meterTone(limit.percent / 100)}
              valueText={`${limit.percent} %`}
              tooltip={false}
              track="surface"
            />
          )}
          <span className="w-24 shrink-0 text-right text-[length:var(--vx-text-sm)] text-muted-foreground tabular-nums">
            {limit.resetsAt === null ? 'no reset' : `resets ${resetWords(limit.resetsAt, now, 'short')}`}
          </span>
        </div>
      ))}
    </div>
  )
}

function Lanes({ account, lanes }: { account: AccountRow; lanes: string[] }) {
  return (
    <ul className="grid gap-1 text-[length:var(--vx-text-sm)]">
      {lanes.flatMap((lane) => {
        const state = account.lanes[lane]
        if (!state) return []
        return [
          <li key={lane} className="flex min-w-0 items-baseline gap-2">
            <span className="w-24 shrink-0 text-muted-foreground">{lane}</span>
            <span className={cn('min-w-0', state.open ? 'text-foreground' : 'text-muted-foreground')}>
              {state.open ? `takes work, place ${state.position}` : `closed: ${state.why ?? 'no reason given'}`}
            </span>
          </li>,
        ]
      })}
    </ul>
  )
}

function Ledger({ account }: { account: AccountRow }) {
  const bars = ledgerBars(account)
  if (bars.length === 0) {
    return <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">No reset recorded yet</p>
  }
  const when = (at: string) =>
    new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <MiniBars
      name={`${account.id}, weekly percent at each reset`}
      values={bars.map((b) => b.weekly ?? 0)}
      labels={bars.map(
        (b) =>
          `${when(b.at)}${b.weekly === null ? ', no reading' : ''}${b.manual ? ', reset by hand' : ''}${b.rule ? `, rule ${b.rule}` : ''}`,
      )}
      format={(v) => `${v} %`}
      height={48}
    />
  )
}

/** The four intents; each shows its expiry and what the API said back. */
function Actions({ account, now }: { account: AccountRow; now: Date }) {
  const queryClient = useQueryClient()
  const [expiry, setExpiry] = useState<Record<Intent, string>>({
    'fill-first': EXPIRIES['fill-first'][0].key,
    'hold-for-a-model': EXPIRIES['hold-for-a-model'][0].key,
    pause: EXPIRIES.pause[0].key,
  })
  const [model, setModel] = useState(defaultHoldModel(account))
  const refetch = () => queryClient.invalidateQueries({ queryKey: ['accounts'] })
  const set = useMutation({ mutationFn: (intent: Intent) => run(intent), onSuccess: refetch })
  const clear = useMutation({ mutationFn: () => clearAccountMode(account.id), onSuccess: refetch })
  async function run(intent: Intent) {
    const choice = EXPIRIES[intent].find((c) => c.key === expiry[intent]) ?? EXPIRIES[intent][0]
    const body = intentBody(intent, choice, now, model)
    if (body === null) throw new Error('Name the model to hold the account for.')
    return setAccountMode(account.id, body)
  }
  const busy = set.isPending || clear.isPending
  const error = set.error ?? clear.error
  const select = (intent: Intent) =>
    EXPIRIES[intent].length > 1 ? (
      <select
        aria-label={`${INTENT_LABELS[intent]} for ${account.id}: how long`}
        value={expiry[intent]}
        onChange={(event) => setExpiry({ ...expiry, [intent]: event.target.value })}
        className="h-7 rounded-lg border border-input bg-transparent px-2 text-[length:var(--vx-text-sm)] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {EXPIRIES[intent].map((choice) => (
          <option key={choice.key} value={choice.key}>
            {choice.label}
          </option>
        ))}
      </select>
    ) : (
      <span className="text-[length:var(--vx-text-sm)] text-muted-foreground">
        {EXPIRIES[intent][0].label.toLowerCase()}
      </span>
    )
  const button = (intent: Intent) => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      aria-label={`${INTENT_LABELS[intent]} ${account.id}`}
      onClick={() => {
        clear.reset()
        set.mutate(intent)
      }}
    >
      {INTENT_LABELS[intent]}
    </Button>
  )
  return (
    <div className="grid gap-2" role="group" aria-label={`Steer ${account.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        {button('fill-first')}
        {select('fill-first')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {button('hold-for-a-model')}
        <Input
          aria-label={`Model to hold ${account.id} for`}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="h-7 w-24"
        />
        {select('hold-for-a-model')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {button('pause')}
        {select('pause')}
      </div>
      {account.mode.source === 'override' && account.mode.kind !== 'normal' ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Back to normal ${account.id}`}
            onClick={() => {
              set.reset()
              clear.mutate()
            }}
          >
            Back to normal
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--vx-text-sm)] text-destructive">
          {error.message}
        </p>
      ) : null}
    </div>
  )
}

function AccountPanel({ account, lanes, now }: { account: AccountRow; lanes: string[]; now: Date }) {
  const weekly = limitsOf(account).find((l) => l.key === 'weekly_all')
  const forecast = forecastWords(account, weekly?.resetsAt ?? null, now)
  return (
    <article aria-label={`Account ${account.id}`} data-account={account.id} className={SHELL}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        <h3 className="font-heading text-[length:var(--vx-text-md)] font-semibold tracking-tight">{account.id}</h3>
        <Lozenge tone="neutral">{account.plan}</Lozenge>
        <ModeBadge account={account} now={now} />
        <span className="ml-auto text-[length:var(--vx-text-sm)] text-muted-foreground tabular-nums">
          {account.seats.taken} of {account.seats.cap} leads allowed
          {account.leads.length > 0
            ? ` · Issue ${account.leads.map((lead) => lead.replace('issue_', '')).join(', ')}`
            : ''}
        </span>
      </header>
      <div className={INSET}>
        <p className="mb-4 text-[length:var(--vx-text-md)]" data-testid="forecast">
          <span className="font-semibold text-foreground">{forecast.head}</span>
          {forecast.rest ? <span className="text-muted-foreground">, {forecast.rest}</span> : null}
          {account.closed ? (
            <span className="text-[length:var(--vx-text-sm)] text-muted-foreground">
              {' '}
              · closed: {account.closed.why}
            </span>
          ) : null}
        </p>
        <div className="grid gap-6 lg:grid-cols-3">
          <section aria-label="Limits" className="grid min-w-0 content-start gap-4">
            <Limits account={account} now={now} />
            <Lanes account={account} lanes={lanes} />
          </section>
          <section aria-label="Last resets" className="min-w-0">
            <h4 className="mb-2 text-[length:var(--vx-text-sm)] font-medium">Weekly percent at the last resets</h4>
            <Ledger account={account} />
          </section>
          <section aria-label="Steer" className="min-w-0">
            <h4 className="mb-2 text-[length:var(--vx-text-sm)] font-medium">Steer this account</h4>
            <Actions account={account} now={now} />
          </section>
        </div>
      </div>
    </article>
  )
}

function Accounts() {
  const { lane: asked } = Route.useSearch()
  const accounts = useAccounts()
  const screen = useScreen(accounts)
  const note = useScreenNote(screen, accounts.error)
  const now = new Date(useNow(30_000))
  const view = accounts.data
  if (!view) {
    return (
      <Page fluid>
        <PageHeader title="Accounts" loading={screen === 'loading'} note={note} />
        {screen === 'loading' ? <AccountsSkeleton /> : null}
      </Page>
    )
  }
  const lane = view.lanes.includes(asked ?? DEFAULT_LANE) ? (asked ?? DEFAULT_LANE) : DEFAULT_LANE
  const inService = view.accounts.filter((account) => account.enabled)
  const off = view.accounts.filter((account) => !account.enabled)
  return (
    <Page fluid>
      <PageHeader title="Accounts" />
      <div className="grid gap-8">
        <Section title="Order now" hint="account" aside={<LaneSwitch lanes={view.lanes} lane={lane} />}>
          {inService.length === 0 ? (
            <EmptyState title="No account is in service">Add one with claude-account add, then verify it.</EmptyState>
          ) : (
            <OrderNow view={view} lane={lane} />
          )}
        </Section>
        <Section title="Quota used at reset" hint="quota used at reset">
          <Score />
        </Section>
        <Section title="Each account" aside={`${inService.length} in service`}>
          <div className="grid gap-4">
            {inService.map((account) => (
              <AccountPanel key={account.id} account={account} lanes={view.lanes} now={now} />
            ))}
          </div>
          {off.length > 0 ? (
            <p className="mt-4 text-[length:var(--vx-text-sm)] text-muted-foreground">
              Not in service: {off.map((account) => account.id).join(', ')}. Switch one on with claude-account verify
              --enable.
            </p>
          ) : null}
        </Section>
      </div>
    </Page>
  )
}
