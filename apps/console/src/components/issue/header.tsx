import type { ReadIssueDetail } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { KindBadge } from '@/components/kit/kind-badge'
import { Lozenge } from '@/components/kit/lozenge'
import { PropertyList } from '@/components/kit/property-list'
import { durationWords } from '@/components/kit/step-rail'
import { ISSUE_STATE_WORDS } from '@/lib/issue'
import { kindOf, lozengeStateOf, nextActions, regressionCount } from '@/lib/issue-page'
import { spanWords } from '@/lib/needs'
import { Ago } from './ago'
import { ProjectChip } from './project-chip'
import { LINK_CLASS } from './source-link'

/** Title, state, the owner's next moves as links, and the facts. The Console only links: it never starts or cancels. */
export function Header({ issue, now }: { issue: ReadIssueDetail; now: number }) {
  const { insights } = issue
  const kind = kindOf(issue.kind)
  const regressions = regressionCount(issue)
  const { decisionId, artifactId } = nextActions(issue)
  const closedAt = issue.state === 'closed' ? issue.closedAt : null
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {kind ? <KindBadge kind={kind} /> : null}
        <Lozenge state={lozengeStateOf(issue)}>
          {issue.state === 'closed' ? undefined : ISSUE_STATE_WORDS[issue.state]}
        </Lozenge>
        {issue.waitingOnOwner ? <Lozenge state="waiting">Waiting on you</Lozenge> : null}
        {regressions > 0 ? <Lozenge tone="bad">{`Regressed ${regressions}×`}</Lozenge> : null}
        <ProjectChip name={issue.repoName} />
      </div>
      <h1 className="font-heading text-xl font-semibold tracking-tight">{issue.title}</h1>
      {issue.summary ? (
        <p className="max-w-[75ch] text-[length:var(--vx-text-sm)] text-muted-foreground">{issue.summary}</p>
      ) : null}
      <nav aria-label="Next moves" className="flex flex-wrap gap-x-5 gap-y-1 text-[length:var(--vx-text-sm)]">
        {decisionId ? (
          <Link to="/needs-you" search={{ item: decisionId }} className={LINK_CLASS}>
            Answer on Needs you
          </Link>
        ) : null}
        {artifactId ? (
          <Link to="/artifacts/$id" params={{ id: artifactId }} className={LINK_CLASS}>
            Give a verdict
          </Link>
        ) : null}
        <Link to="/chain" className={LINK_CLASS}>
          See it on the Chain
        </Link>
      </nav>
      <PropertyList
        className="mt-2 grid-cols-2 gap-y-3 min-[40rem]:grid-cols-3 min-[64rem]:grid-cols-6"
        items={[
          { label: 'Phase', value: issue.phase },
          { label: 'Created', value: <Ago iso={issue.createdAt} now={now} className="font-mono text-xs" /> },
          closedAt
            ? { label: 'Closed', value: <Ago iso={closedAt} now={now} className="font-mono text-xs" /> }
            : { label: 'Updated', value: <Ago iso={issue.updatedAt} now={now} className="font-mono text-xs" /> },
          { label: 'Elapsed', value: <span className="tabular-nums">{spanWords(insights.elapsedMs)}</span> },
          { label: 'Working time', value: <span className="tabular-nums">{durationWords(insights.workingMs)}</span> },
          { label: 'Attempts', value: <span className="tabular-nums">{insights.attempts}</span> },
        ]}
      />
    </header>
  )
}
