import type { ReadIssueDetail } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { ARTIFACT_KIND_LABEL } from '@/lib/needs'
import { spanWords } from '@/lib/needs'
import {
  agoWords,
  askStatusWords,
  attemptOf,
  checkWords,
  countWords,
  deliveryWords,
  ISSUE_STATE_WORDS,
  originWords,
  SESSION_STATE_WORDS,
  settledByWords,
  standingWords,
  triageKindWords,
  trustWords,
  verdictWords,
  watchWords,
} from '@/lib/issue'
import { accountMeter, resetWords } from '@/lib/strip'
import { Card, Meta, Muted, Section, SourceLink, Stat, Stats } from './parts'

type Issue = ReadIssueDetail
type Insights = Issue['insights']

export function Header({ issue, now }: { issue: Issue; now: number }) {
  return (
    <header className="mb-6 flex flex-col gap-2">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{issue.title}</h1>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={issue.state === 'closed' ? 'secondary' : 'default'}>{ISSUE_STATE_WORDS[issue.state]}</Badge>
        {issue.waitingOnOwner ? <Badge variant="destructive">Waiting on you</Badge> : null}
        {standingWords(issue) ? <span>{standingWords(issue)}</span> : null}
      </p>
      {issue.summary ? <p className="text-sm text-muted-foreground">{issue.summary}</p> : null}
      <Meta>
        <span>{issue.repoName}</span>
        {issue.kind ? <span>{issue.kind}</span> : null}
        {issue.size ? <span>{issue.size}</span> : null}
        <span>Created {agoWords(issue.createdAt, now)}</span>
        <span>Updated {agoWords(issue.updatedAt, now)}</span>
        {issue.closedAt ? <span>Closed {agoWords(issue.closedAt, now)}</span> : null}
        {issue.closedAt && issue.outcome ? <span>Outcome: {issue.outcome.replaceAll('_', ' ')}</span> : null}
      </Meta>
    </header>
  )
}

function TokenStats({ insights }: { insights: Insights }) {
  const { tokens } = insights
  return (
    <>
      <Stat label="Tokens in">{countWords(tokens.input)}</Stat>
      <Stat label="Tokens out">{countWords(tokens.output)}</Stat>
      <Stat label="Cache read">{countWords(tokens.cacheRead)}</Stat>
      <Stat label="Cache write">{countWords(tokens.cacheWrite)}</Stat>
    </>
  )
}

export function Facts({ issue, now }: { issue: Issue; now: number }) {
  const { insights, quota } = issue
  const meter = quota ? accountMeter(quota, new Date(now)) : null
  return (
    <Section title="Facts">
      {issue.about ? <p className="text-sm">{issue.about}</p> : null}
      <Stats>
        <Stat label="Account">{issue.account ?? 'none yet'}</Stat>
        {meter ? (
          <Stat label="Weekly quota">
            {meter.weeklyPct === null ? 'no reading' : `${meter.weeklyPct}%`}
            {quota?.weeklyResetsAt ? `, resets ${resetWords(quota.weeklyResetsAt, new Date(now))}` : ''}
            {meter.note ? ` (${meter.note})` : ''}
          </Stat>
        ) : null}
        <Stat label="Elapsed">{spanWords(insights.elapsedMs)}</Stat>
        <Stat label="Working time">{spanWords(insights.workingMs)}</Stat>
        <Stat label="Turns">{insights.turns}</Stat>
        <Stat label="Attempts">{insights.attempts}</Stat>
        <TokenStats insights={insights} />
        {insights.partial ? null : (
          <>
            <Stat label="Tool calls">{insights.toolCalls}</Stat>
            <Stat label="Subagents">{insights.subagents}</Stat>
          </>
        )}
        <Stat label="Models">{insights.models.length > 0 ? insights.models.join(', ') : 'none yet'}</Stat>
      </Stats>
      {insights.partial ? <Muted>Tool calls and subagents are not counted yet.</Muted> : null}
    </Section>
  )
}

export function Triage({ issue, now }: { issue: Issue; now: number }) {
  const [filed, ...amended] = issue.triage
  return (
    <Section title="How it came to be">
      {filed ? (
        <>
          <Signal line={filed} lead="Filed by" now={now} />
          {amended.map((line) => (
            <Signal key={`${line.at}|${line.title}|${line.text}`} line={line} lead="Amended by" now={now} />
          ))}
        </>
      ) : (
        <Muted>Filed directly, not from a signal.</Muted>
      )}
    </Section>
  )
}

function Signal({ line, lead, now }: { line: Issue['triage'][number]; lead: string; now: number }) {
  return (
    <Card>
      <p className="font-medium">
        {lead} {originWords(line.origin).toLowerCase()}
        <span className="font-normal text-muted-foreground">
          {' '}
          · {triageKindWords(line.kind)}, {trustWords(line.trust)}
        </span>
      </p>
      <Meta>
        {line.source ? <span>Source {line.source}</span> : null}
        <span>{agoWords(line.at, now)}</span>
      </Meta>
      {line.title ? <blockquote className="border-l-2 pl-3 font-medium">{line.title}</blockquote> : null}
      {line.text ? <blockquote className="border-l-2 pl-3 whitespace-pre-wrap">{line.text}</blockquote> : null}
      <SourceLink href={line.link}>Open the source</SourceLink>
    </Card>
  )
}

export function Sessions({ issue, now }: { issue: Issue; now: number }) {
  return (
    <Section title="Attempts" count={issue.sessions.length}>
      {issue.sessions.length === 0 ? <Muted>No attempt has started yet.</Muted> : null}
      {issue.sessions.map((session, index) => (
        <Card key={session.id}>
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Attempt {index + 1}</span>
            <Badge variant={session.state === 'working' ? 'default' : 'secondary'}>
              {SESSION_STATE_WORDS[session.state]}
            </Badge>
            {session.wait ? (
              <span className="text-muted-foreground">waiting for {session.wait.replaceAll('_', ' ')}</span>
            ) : null}
          </p>
          {session.summary ? <p>{session.summary}</p> : null}
          <Meta>
            <span>Turn {session.turn}</span>
            {session.model ? <span>{session.model}</span> : null}
            {session.since ? <span>Since {agoWords(session.since, now)}</span> : null}
            <span>Last activity {agoWords(session.lastActivityAt, now)}</span>
          </Meta>
          <Stats>
            <Stat label="Turns">{session.insights.turns}</Stat>
            <Stat label="Working time">{spanWords(session.insights.workingMs)}</Stat>
            <Stat label="Tokens in">{countWords(session.insights.tokens.input)}</Stat>
            <Stat label="Tokens out">{countWords(session.insights.tokens.output)}</Stat>
          </Stats>
        </Card>
      ))}
    </Section>
  )
}

export function Notes({ issue, now }: { issue: Issue; now: number }) {
  return (
    <Section title="Notes you sent" count={issue.notes.length}>
      {issue.notes.length === 0 ? <Muted>You sent no note.</Muted> : null}
      {issue.notes.map((note) => (
        <Card key={`${note.at}|${note.text}`}>
          <p className="whitespace-pre-wrap">{note.text}</p>
          <Meta>
            <span>{agoWords(note.at, now)}</span>
            <span>{deliveryWords(note.delivered)}</span>
          </Meta>
        </Card>
      ))}
    </Section>
  )
}

export function Decisions({ issue, now }: { issue: Issue; now: number }) {
  return (
    <Section title="Decisions" count={issue.asks.length}>
      {issue.asks.length === 0 ? <Muted>The lead asked nothing.</Muted> : null}
      {issue.asks.map((ask) => (
        <Card key={ask.id}>
          <p className="font-medium">{ask.question}</p>
          <Meta>
            <Badge variant={ask.status === 'open' ? 'default' : 'secondary'}>{askStatusWords(ask.status)}</Badge>
            <span>Asked {agoWords(ask.askedAt, now)}</span>
            {ask.answeredAt ? <span>Settled {agoWords(ask.answeredAt, now)}</span> : null}
          </Meta>
          <p>
            <span className="text-muted-foreground">Recommendation: </span>
            {ask.recommendation}
          </p>
          <p>
            <span className="text-muted-foreground">Checked: </span>
            {ask.checked}
          </p>
          <ul className="grid gap-1">
            {ask.options.map((option) => (
              <li key={option} className="flex flex-wrap gap-2">
                <span>{option}</span>
                {option === ask.default ? <span className="text-muted-foreground">(default)</span> : null}
              </li>
            ))}
          </ul>
          {ask.answer ? (
            <p className="font-medium">
              Answer: {ask.answer}
              <span className="font-normal text-muted-foreground"> {settledByWords(ask.settledBy)}</span>
            </p>
          ) : null}
          {ask.status === 'open' ? (
            <Link to="/needs-you" search={{ item: ask.id }} className="w-fit text-primary underline underline-offset-4">
              Answer it on Needs you
            </Link>
          ) : null}
        </Card>
      ))}
    </Section>
  )
}

export function Artifacts({ issue, now }: { issue: Issue; now: number }) {
  return (
    <Section title="Artifacts" count={issue.artifacts.length}>
      {issue.artifacts.length === 0 ? <Muted>No Concept, Spec or Report yet.</Muted> : null}
      {issue.artifacts.map((artifact) => (
        <Card key={artifact.id}>
          <p className="font-medium">{artifact.title}</p>
          <Meta>
            <span>{ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}</span>
            <span>
              {artifact.revisions} {artifact.revisions === 1 ? 'revision' : 'revisions'}
            </span>
            <span>{verdictWords(artifact.verdict)}</span>
            <span>{agoWords(artifact.at, now)}</span>
          </Meta>
          <Link
            to="/artifacts/$id"
            params={{ id: artifact.id }}
            className="w-fit text-primary underline underline-offset-4"
          >
            Open the artifact
          </Link>
        </Card>
      ))}
    </Section>
  )
}

export function Shipping({ issue, now }: { issue: Issue; now: number }) {
  if (issue.shipping.length === 0 && issue.evidence.length === 0)
    return (
      <Section title="Shipping and evidence">
        <Muted>Nothing has been shipped yet.</Muted>
      </Section>
    )
  return (
    <Section title="Shipping and evidence" count={issue.shipping.length} collapsible>
      {issue.shipping.map((ship) => (
        <Card key={`${ship.at}|${ship.attempt}`}>
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant={ship.result === 'accepted' ? 'default' : 'destructive'}>
              {ship.result === 'accepted' ? 'Accepted' : 'Refused'}
            </Badge>
            <span className="text-muted-foreground">
              {agoWords(ship.at, now)}, attempt {ship.attempt}
            </span>
          </p>
          {ship.detail ? <p className="whitespace-pre-wrap">{ship.detail}</p> : null}
          <p>
            {ship.commits.length} {ship.commits.length === 1 ? 'commit' : 'commits'}
            {ship.commits.length > 0 ? (
              <span className="font-mono text-xs text-muted-foreground">
                {' '}
                {ship.commits.map((sha) => sha.slice(0, 7)).join(' ')}
              </span>
            ) : null}
          </p>
          <p>
            Review: {ship.review.present ? 'present' : 'none'}
            {ship.review.note ? <span className="text-muted-foreground"> ({ship.review.note})</span> : null}
          </p>
          {ship.watch ? <p>Watch: {watchWords(ship.watch, now)}</p> : null}
          {ship.checks.length > 0 ? (
            <ul className="grid gap-1">
              {ship.checks.map((check) => (
                <li key={check.at}>
                  <span className="font-medium">{checkWords(check.result)}</span>
                  <span className="text-muted-foreground"> {agoWords(check.at, now)}: </span>
                  {check.summary}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ))}
      {issue.evidence.length > 0 ? (
        <Card>
          <p className="font-medium">Evidence</p>
          <ul className="grid gap-1">
            {issue.evidence.map((line) => (
              <li key={`${line.kind}|${line.at}`}>
                <span className="capitalize">{line.kind.replaceAll('_', ' ')}</span>
                <span className="text-muted-foreground">
                  {' '}
                  {agoWords(line.at, now)}
                  {line.note ? `: ${line.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  )
}

/** Oldest first: the log reads as the story, top to bottom. */
export function History({ issue, now }: { issue: Issue; now: number }) {
  return (
    <Section title="History, oldest first" count={issue.timeline.length} collapsible open={false}>
      <ol className="grid gap-2">
        {issue.timeline.map((line, index) => {
          const attempt = attemptOf(issue.sessions, line.session)
          return (
            <li key={`${line.at}|${index}`} className="grid gap-0.5 rounded-lg border px-3 py-2 text-sm">
              <span>{line.text}</span>
              <Meta>
                <span>{agoWords(line.at, now)}</span>
                {attempt === null ? null : <span>Attempt {attempt}</span>}
              </Meta>
            </li>
          )
        })}
      </ol>
    </Section>
  )
}
