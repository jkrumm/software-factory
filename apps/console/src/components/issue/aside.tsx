import type { ReadIssueDetail } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { Lozenge, LOZENGE_STATES, type LozengeState } from '@/components/kit/lozenge'
import { MeterBar, meterTone } from '@/components/kit/meter'
import { PropertyList } from '@/components/kit/property-list'
import { Section } from '@/components/kit/section'
import { Skeleton } from '@/components/kit/skeleton'
import { issueNumber, stateWord } from '@/lib/chain'
import { originWords } from '@/lib/issue'
import { type ChainLink, chainAround } from '@/lib/issue-page'
import { useChain } from '@/lib/queries'
import { accountMeter, resetWords } from '@/lib/strip'
import { ProjectChip } from './project-chip'
import { LINK_CLASS, SourceLink } from './source-link'

type Issue = ReadIssueDetail

const asLozengeState = (state: string): LozengeState | null => LOZENGE_STATES.find((known) => known === state) ?? null

function WeeklyQuota({ issue, now }: { issue: Issue; now: number }) {
  if (!issue.quota) return null
  const meter = accountMeter(issue.quota, new Date(now))
  return (
    <div className="flex flex-col gap-1.5">
      <p className="tabular-nums">
        {meter.weeklyPct === null ? 'No reading' : `${meter.weeklyPct}%`}
        <span className="text-muted-foreground">
          {' '}
          · resets {resetWords(issue.quota.weeklyResetsAt, new Date(now))}
          {meter.note ? ` (${meter.note})` : ''}
        </span>
      </p>
      {meter.weeklyPct === null ? null : (
        <MeterBar value={meter.weeklyPct / 100} tone={meterTone(meter.weeklyPct / 100)} track="surface" />
      )}
    </div>
  )
}

function WaitsBehind({ issue }: { issue: Issue }) {
  const chain = useChain()
  if (issue.heldBy === null) return null
  const title = chain.data?.nodes.find((node) => node.id === `issue_${issue.heldBy}`)?.title ?? 'Another Issue'
  return (
    <Link to="/issues/$id" params={{ id: String(issue.heldBy) }} className={LINK_CLASS}>
      {title}
    </Link>
  )
}

export function Properties({ issue, now }: { issue: Issue; now: number }) {
  const filed = issue.triage[0]
  const closed = issue.state === 'closed'
  return (
    <Section title="Properties">
      <PropertyList
        className="min-[40rem]:grid-cols-1 gap-y-3"
        items={[
          { label: 'Project', value: <ProjectChip name={issue.repoName} /> },
          { label: 'Kind', value: issue.kind ? <span className="capitalize">{issue.kind}</span> : null },
          { label: 'Size', value: issue.size },
          {
            label: 'Origin',
            value: filed ? (
              <span className="flex flex-wrap items-center gap-x-3">
                {originWords(filed.origin)}
                <SourceLink href={filed.link}>Source</SourceLink>
              </span>
            ) : null,
          },
          { label: 'Account', value: issue.account },
          { label: 'Weekly quota', value: <WeeklyQuota issue={issue} now={now} /> },
          { label: 'Models', value: issue.insights.models.join(', ') },
          { label: 'Waits behind', value: issue.heldBy === null ? null : <WaitsBehind issue={issue} /> },
          closed ? { label: 'Closed', value: issue.outcome?.replaceAll('_', ' ') ?? 'Closed' } : null,
        ].flatMap((item) => (item ? [item] : []))}
      />
    </Section>
  )
}

function LinkRow({ link }: { link: ChainLink }) {
  const { node } = link
  const number = issueNumber(node)
  const state = asLozengeState(node.state)
  return (
    <li className="flex flex-col gap-1 py-2 not-first:border-t">
      <div className="flex items-start gap-2">
        {number ? (
          <Link to="/issues/$id" params={{ id: number }} className={`${LINK_CLASS} min-w-0 flex-1 font-medium`}>
            {node.title}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 font-medium">{node.title}</span>
        )}
        {link.closed ? <Lozenge tone="good">Done</Lozenge> : <Lozenge tone="warn">Blocking</Lozenge>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {node.repo ? <ProjectChip name={node.repo} /> : null}
        {state ? <Lozenge state={state} /> : <span>{stateWord(node.state)}</span>}
      </div>
    </li>
  )
}

function Group({ label, links }: { label: string; links: ChainLink[] }) {
  if (links.length === 0) return null
  return (
    <div>
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      <ul className="flex flex-col">
        {links.map((link) => (
          <LinkRow key={link.node.id} link={link} />
        ))}
      </ul>
    </div>
  )
}

export function ChainAround({ issue }: { issue: Issue }) {
  const chain = useChain()
  const around = chain.data ? chainAround({ chain: chain.data, ref: issue.ref }) : null
  return (
    <Section title="Chain around this Issue" hint="chain">
      <div className="flex flex-col gap-4 text-[length:var(--vx-text-sm)]">
        {chain.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : null}
        {chain.isError ? <p className="text-muted-foreground">The Chain is not available right now.</p> : null}
        {around && around.blockedBy.length === 0 && around.blocks.length === 0 ? (
          <p className="text-muted-foreground">This Issue waits on nothing and nothing waits on it.</p>
        ) : null}
        {around ? (
          <>
            <Group label="Waits on" links={around.blockedBy} />
            <Group label="Blocks" links={around.blocks} />
          </>
        ) : null}
        <Link to="/chain" className={LINK_CLASS}>
          Open the Chain
        </Link>
      </div>
    </Section>
  )
}
