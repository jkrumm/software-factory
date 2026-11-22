import type { AccountRow } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { Meter, MeterBar } from '@/components/kit/meter'
import { meterTone, TONE_TEXT } from '@/components/kit/tone'
import { PopoverTitle } from '@/components/ui/popover'
import { type LoginLine, loginAlerts, loginMark, modeLabel, modeSource, modeUntil } from '@/lib/accounts'
import { useNow } from '@/lib/now'
import { useAccounts } from '@/lib/queries'
import { accountMeter, isExhausted, resetWords, usedPct } from '@/lib/strip'
import { StripPopover } from './strip-popover'

/** One window: its label, the used share as a bar with its figure, and the reset time, muted, on the same line. */
function Window({
  label,
  name,
  pct,
  resetsAt,
  now,
}: {
  label: string
  name: string
  pct: number | null
  resetsAt: string | null
  now: Date
}) {
  return (
    <div className="flex min-h-6 items-center gap-3">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      {pct === null ? (
        <span className="flex-1 text-muted-foreground">-</span>
      ) : (
        <Meter
          className="flex-1"
          tooltip={false}
          track="surface"
          name={name}
          value={pct / 100}
          tone={meterTone(pct / 100)}
          valueText={`${pct} %`}
        />
      )}
      <span className="w-20 shrink-0 text-right text-muted-foreground tabular-nums">
        {resetsAt === null ? '-' : resetWords(resetsAt, now, 'short')}
      </span>
    </div>
  )
}

function AccountDetail({ quota, alerts, now }: { quota: AccountRow; alerts: LoginLine[]; now: Date }) {
  return (
    <>
      <PopoverTitle>Subscription {quota.account}</PopoverTitle>
      <div className="mt-2 flex flex-col gap-2">
        <Window
          label="This week"
          name={`${quota.account}, this week`}
          pct={usedPct(quota.weeklyUsed)}
          resetsAt={quota.weeklyResetsAt}
          now={now}
        />
        <Window
          label="5 h"
          name={`${quota.account}, 5 h`}
          pct={usedPct(quota.fiveHourUsed)}
          resetsAt={quota.fiveHourResetsAt}
          now={now}
        />
        {quota.mode.kind === 'normal' ? null : (
          <p>
            {modeLabel(quota.mode)} {modeUntil(quota.mode, now)} · {modeSource(quota.mode)}
          </p>
        )}
        {alerts.map((line) => (
          <p key={line.key} data-testid="strip-login-line" className={TONE_TEXT[line.tone]}>
            {line.machine}: {line.label.toLowerCase()}, {line.words.toLowerCase()}
          </p>
        ))}
        {quota.fresh ? null : <p className="text-[color:var(--vx-warn-solid)]">Stale</p>}
        {isExhausted(quota, now) ? <p>At its limit until {resetWords(quota.exhaustedUntil, now)}</p> : null}
        <Link
          to="/accounts"
          className="underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Open the accounts
        </Link>
      </div>
    </>
  )
}

/** One meter per subscription: its weekly share on a 4 rem bar, and the used share per window in a popover. */
export function Accounts() {
  const view = useAccounts().data
  const accounts = view?.accounts.filter((a) => a.enabled)
  const now = new Date(useNow(30_000))
  if (!view || !accounts) return null
  return (
    <div className="flex items-center gap-x-1 min-[1280px]:flex-wrap">
      {accounts.map((quota) => {
        const { weeklyPct, tone } = accountMeter(quota, now)
        const alerts = loginAlerts(view, quota.account, now)
        const mark = loginMark(alerts)
        return (
          <StripPopover
            key={quota.account}
            label={`${quota.account}, ${weeklyPct === null ? 'no reading' : `${weeklyPct} % of this week used`}`}
            className="w-[25rem]"
            trigger={
              <>
                <span className="max-w-28 truncate">{quota.account}</span>
                {quota.mode.kind === 'normal' ? null : <span data-testid="strip-mode">{modeLabel(quota.mode)}</span>}
                {mark === null ? null : (
                  <span data-testid="strip-login" className={TONE_TEXT[mark.tone]}>
                    {mark.label.toLowerCase()}
                  </span>
                )}
                <span className="w-16">
                  <MeterBar value={(weeklyPct ?? 0) / 100} tone={tone} track="surface" />
                </span>
                <span>{weeklyPct === null ? '-' : `${weeklyPct}%`}</span>
              </>
            }
          >
            <AccountDetail quota={quota} alerts={alerts} now={now} />
          </StripPopover>
        )
      })}
    </div>
  )
}
