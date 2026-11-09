import { CheckCircleIcon, XCircleIcon } from '@phosphor-icons/react'
import type { ReadIssueDetail } from '@software-factory/contract'
import { EmptyState } from '@/components/kit/empty-state'
import { Fold } from '@/components/kit/fold'
import { Lozenge } from '@/components/kit/lozenge'
import { Section } from '@/components/kit/section'
import { type Step, StepRail } from '@/components/kit/step-rail'
import { agoWords, watchWords } from '@/lib/issue'
import { checkPassed, shipStatus } from '@/lib/issue-page'
import { Ago } from './ago'
import { SourceLink } from './source-link'

type Ship = ReadIssueDetail['shipping'][number]

const clock = (iso: string): string => new Date(iso).toLocaleTimeString('en-GB', { hour12: false })

const checkSteps = (ship: Ship): Step[] =>
  ship.checks.map((check, index) => ({
    id: `${index}-${check.at}`,
    label: check.summary,
    at: clock(check.at),
    failed: checkPassed(check.result) ? undefined : true,
    icon: checkPassed(check.result) ? CheckCircleIcon : undefined,
  }))

function Facts({ ship, now }: { ship: Ship; now: number }) {
  return (
    <div className="flex flex-col gap-2 text-[length:var(--vx-text-sm)]">
      {ship.detail ? <p className="max-w-[75ch] whitespace-pre-wrap">{ship.detail}</p> : null}
      <p>
        <span className="text-muted-foreground">
          {ship.commits.length} {ship.commits.length === 1 ? 'commit' : 'commits'}
        </span>
        {ship.commits.length > 0 ? (
          <span className="ml-2 font-mono text-xs tabular-nums break-all">
            {ship.commits.map((sha) => sha.slice(0, 7)).join(' ')}
          </span>
        ) : null}
      </p>
      <p>
        {ship.review.present ? 'Review: present' : 'No review'}
        {ship.review.note ? <span className="text-muted-foreground"> ({ship.review.note})</span> : null}
      </p>
      {ship.watch ? <p>Watch: {watchWords(ship.watch, now)}</p> : null}
    </div>
  )
}

function Acceptance({ ship }: { ship: Ship }) {
  if (ship.result !== 'accepted' || !ship.acceptance) return null
  if (ship.acceptance.length === 0)
    return <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">No statement against the acceptance.</p>
  return (
    <ul className="flex flex-col text-[length:var(--vx-text-sm)]">
      {ship.acceptance.map((line, index) => {
        const met = line.status === 'met'
        const StatusIcon = met ? CheckCircleIcon : XCircleIcon
        return (
          <li key={`${line.status}|${index}`} className="flex items-start gap-2 py-1.5 not-first:border-t">
            <StatusIcon
              weight="fill"
              aria-hidden="true"
              className={
                met ? 'mt-0.5 size-4 shrink-0 text-muted-foreground' : 'mt-0.5 size-4 shrink-0 text-destructive'
              }
            />
            <span className="w-14 shrink-0 font-medium">{met ? 'Met' : 'Not met'}</span>
            <span className="min-w-0 max-w-[75ch]">{line.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ShipSection({ ship, now }: { ship: Ship; now: number }) {
  const status = shipStatus(ship)
  return (
    <Section
      title={`Shipped ${agoWords(ship.at, now)} · attempt ${ship.attempt}`}
      aside={
        <span className="flex items-center gap-3">
          <time dateTime={ship.at} className="font-mono text-xs tabular-nums">
            {new Date(ship.at).toLocaleString('en-GB')}
          </time>
          <Lozenge tone={status.tone}>{status.label}</Lozenge>
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <Facts ship={ship} now={now} />
        <Acceptance ship={ship} />
        {ship.checks.length > 0 ? <StepRail steps={checkSteps(ship)} /> : null}
      </div>
    </Section>
  )
}

export function Evidence({ issue, now }: { issue: ReadIssueDetail; now: number }) {
  if (issue.shipping.length === 0 && issue.evidence.length === 0)
    return <EmptyState title="Nothing has been shipped yet." />
  const ships = [...issue.shipping].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return (
    <div className="flex flex-col gap-8">
      {ships.map((ship) => (
        <ShipSection key={`${ship.at}|${ship.attempt}`} ship={ship} now={now} />
      ))}
      {issue.evidence.length > 0 ? (
        <Fold title="Recorded evidence" count={issue.evidence.length}>
          <ul className="flex flex-col text-[length:var(--vx-text-sm)]">
            {issue.evidence.map((line) => (
              <li
                key={`${line.kind}|${line.at}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 not-first:border-t"
              >
                <span className="font-medium capitalize">{line.kind.replaceAll('_', ' ')}</span>
                {line.note ? <span className="min-w-0 max-w-[75ch] text-muted-foreground">{line.note}</span> : null}
                <Ago iso={line.at} now={now} className="font-mono text-xs text-muted-foreground" />
                <SourceLink href={line.link}>Open</SourceLink>
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </div>
  )
}
