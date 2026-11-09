import type { ReactNode } from 'react'
import type { ReadAccountQuota } from '@software-factory/contract'
import { InfoHint } from '@/components/kit/info-hint'
import { Meter, MeterBar } from '@/components/kit/meter'
import { PopoverTitle } from '@/components/ui/popover'
import { useNow } from '@/lib/now'
import { useAccounts } from '@/lib/queries'
import { accountMeter, isExhausted, resetWords, usedPct, WARN_AT_PCT } from '@/lib/strip'
import { StripPopover } from './strip-popover'

const toneOf = (pct: number | null) => (pct !== null && pct >= WARN_AT_PCT ? 'warn' : 'accent')

function Row({ label, hint, children }: { label: string; hint?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-6 items-center text-muted-foreground">
        {label}
        {hint ? <InfoHint word="window" className="-my-1 ml-0.5 size-5" /> : null}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/** A used share as a bar, its figure and, under it, when it resets in words. */
function Used({ name, pct, resets }: { name: string; pct: number; resets: string }) {
  return (
    <>
      <Meter tooltip={false} track="surface" name={name} value={pct / 100} tone={toneOf(pct)} valueText={`${pct} %`} />
      <p className="text-xs text-muted-foreground">{resets}</p>
    </>
  )
}

const resetLine = (iso: string | null, now: Date): string =>
  iso === null ? 'No reset time known' : `Resets ${resetWords(iso, now)}`

function AccountDetail({ quota, now }: { quota: ReadAccountQuota; now: Date }) {
  const weekly = usedPct(quota.weeklyUsed)
  const fiveHour = usedPct(quota.fiveHourUsed)
  return (
    <>
      <PopoverTitle>Subscription {quota.account}</PopoverTitle>
      <dl className="mt-2 grid grid-cols-[7.5rem_1fr] items-start gap-x-3 gap-y-2.5">
        <Row label="This week">
          {weekly === null ? (
            <span className="text-muted-foreground">No reading</span>
          ) : (
            <Used name={`${quota.account}, this week`} pct={weekly} resets={resetLine(quota.weeklyResetsAt, now)} />
          )}
        </Row>
        <Row label="5-hour window" hint>
          {fiveHour === null ? (
            <span className="text-muted-foreground">None on this plan</span>
          ) : (
            <Used
              name={`${quota.account}, 5-hour window`}
              pct={fiveHour}
              resets={resetLine(quota.fiveHourResetsAt, now)}
            />
          )}
        </Row>
        {quota.fresh ? null : (
          <Row label="Reading">
            <span className="text-[color:var(--vx-warn-solid)]">Stale, the last figure is old</span>
          </Row>
        )}
        {isExhausted(quota, now) ? (
          <Row label="Limit">At its limit until {resetWords(quota.exhaustedUntil, now)}</Row>
        ) : null}
      </dl>
    </>
  )
}

/** One meter per subscription: its weekly share on a 4 rem bar, and the formatted detail in a popover. */
export function Accounts() {
  const accounts = useAccounts().data?.accounts
  const now = new Date(useNow(30_000))
  if (!accounts) return null
  return (
    <div className="flex shrink-0 items-center gap-x-1">
      {accounts.map((quota) => {
        const { weeklyPct, warn } = accountMeter(quota, now)
        return (
          <StripPopover
            key={quota.account}
            label={`${quota.account}, ${weeklyPct === null ? 'no reading' : `${weeklyPct} % of this week used`}`}
            className="w-[22rem]"
            trigger={
              <>
                <span className="max-w-28 truncate">{quota.account}</span>
                <span className="w-16">
                  <MeterBar value={(weeklyPct ?? 0) / 100} tone={warn ? 'warn' : 'accent'} track="surface" />
                </span>
                <span>{weeklyPct === null ? '-' : `${weeklyPct}%`}</span>
              </>
            }
          >
            <AccountDetail quota={quota} now={now} />
          </StripPopover>
        )
      })}
    </div>
  )
}
