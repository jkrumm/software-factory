import { CaretDownIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { useAccounts, useFlow, useMachine } from '@/lib/queries'
import { accountMeter, machineWords, resetWords } from '@/lib/strip'
import { cn } from '@/lib/utils'

function Meter({ label, pct, warn }: { label: string; pct: number | null; warn: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span
        role="meter"
        aria-label={`${label}, this week`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        className="relative h-1.5 w-10 rounded-full bg-muted"
      >
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', warn ? 'bg-warn' : 'bg-muted-foreground')}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      {pct === null ? 'no reading' : `${pct}%`}
    </span>
  )
}

/** Working, waiting and queued, as the Flow model counts them. */
function Counts() {
  const { data } = useFlow()
  if (!data) return null
  const { working, waiting, queued } = data.states
  return (
    <p className="flex gap-3" aria-label="Issues in flight">
      <span>{working.count} working</span>
      <span>{waiting.count} waiting</span>
      <span>{queued.count} queued</span>
    </p>
  )
}

/**
 * The strip under the Console's title: the counts, each account's weekly quota and the mini's load and swap. The meters
 * open the detail: weekly reset and the 5-hour window, only where an account has one.
 */
export function StatusStrip() {
  const [open, setOpen] = useState(false)
  const accounts = useAccounts().data?.accounts
  const machine = useMachine().data
  const now = new Date()
  const meters = accounts?.map((quota) => ({ quota, meter: accountMeter(quota, now) }))
  const host = machine ? machineWords(machine) : null

  return (
    <div className="shrink-0 border-b text-xs tabular-nums text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 md:px-8">
        <Counts />
        {meters || host ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="strip-detail"
            className="ml-auto inline-flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 rounded-md text-left hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
          >
            {meters?.map(({ quota, meter }) => (
              <Meter key={quota.account} label={quota.account} pct={meter.weeklyPct} warn={meter.warn} />
            ))}
            {host ? (
              <span className={cn(host.warn && 'text-warn')}>
                {host.load}, {host.swap}
              </span>
            ) : null}
            <CaretDownIcon aria-hidden="true" className={cn('size-3 transition-transform', open && 'rotate-180')} />
          </button>
        ) : null}
      </div>
      {open ? (
        <div id="strip-detail" className="border-t px-4 py-3 md:px-8">
          {meters && meters.length > 0 ? (
            <table className="w-full max-w-2xl text-left">
              <thead>
                <tr>
                  <th className="pr-4 font-medium">Account</th>
                  <th className="pr-4 font-medium">This week</th>
                  <th className="pr-4 font-medium">Resets</th>
                  <th className="font-medium">5-hour window</th>
                </tr>
              </thead>
              <tbody>
                {meters.map(({ quota, meter }) => (
                  <tr key={quota.account}>
                    <td className="pr-4">{quota.account}</td>
                    <td className="pr-4">
                      {meter.weeklyPct === null ? 'no reading' : `${meter.weeklyPct}%`}
                      {meter.note ? `, ${meter.note}` : ''}
                    </td>
                    <td className="pr-4">{resetWords(quota.weeklyResetsAt, now)}</td>
                    <td>
                      {quota.fiveHourUsed === null
                        ? 'none on this plan'
                        : `${Math.round(quota.fiveHourUsed)}%, resets ${resetWords(quota.fiveHourResetsAt, now)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No account has been read yet.</p>
          )}
          {machine && host ? (
            <p className="mt-2">
              Machine: {host.load}, {host.swap}
              {machine.memory ? `, ${machine.memory.swapoutMbPer300s} MiB swapped out in 5 min` : ''}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
