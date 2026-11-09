import { ArrowsCounterClockwiseIcon, DatabaseIcon, TextAlignLeftIcon, TimerIcon } from '@phosphor-icons/react'
import type { ReadIssueDetail } from '@software-factory/contract'
import { useState } from 'react'
import { Lozenge } from '@/components/kit/lozenge'
import { MiniBars } from '@/components/kit/mini-bars'
import { Section } from '@/components/kit/section'
import { StatCard } from '@/components/kit/stat-card'
import { durationWords } from '@/components/kit/step-rail'
import { countWords, originWords, SESSION_STATE_WORDS, triageKindWords, trustWords } from '@/lib/issue'
import { attemptSeries, cacheShare, SESSION_TONES } from '@/lib/issue-page'
import { spanWords } from '@/lib/needs'
import { Ago } from './ago'
import { SourceLink } from './source-link'

type Issue = ReadIssueDetail

const percent = (share: number | null): string => (share === null ? 'None' : `${Math.round(share * 100)}%`)

/** The first, middle and last attempt under the bars; the middle one only with room for three. */
const attemptLabels = (n: number): [string, string, string] => [
  'Attempt 1',
  n >= 3 ? `Attempt ${Math.ceil(n / 2)}` : '',
  `Attempt ${n}`,
]

function Figures({ issue }: { issue: Issue }) {
  const { insights, sessions } = issue
  const series = attemptSeries(sessions)
  const many = sessions.length >= 2
  const { tokens } = insights
  const counted = (value: number): string => (insights.partial ? 'Not counted yet' : countWords(value))
  const cacheShares = sessions.map((s) => Math.round((cacheShare(s.insights.tokens) ?? 0) * 100))
  const subtitle = many ? 'Per attempt' : 'This attempt'
  /** Bars per attempt with the attempts under them; one attempt has nothing to compare, so no chart. */
  const chartOf = (name: string, values: number[], format: (value: number) => string) =>
    many
      ? {
          chart: <MiniBars values={values} labels={series.labels} name={name} format={format} />,
          xLabels: attemptLabels(sessions.length),
        }
      : { chart: null }
  return (
    <div className="grid grid-cols-1 gap-3 min-[30rem]:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={TimerIcon}
        title="Working time"
        subtitle={subtitle}
        value={durationWords(insights.workingMs)}
        footer={[
          { label: 'Elapsed', value: spanWords(insights.elapsedMs) },
          { label: 'Attempts', value: String(insights.attempts) },
        ]}
        {...chartOf('Working time', series.workingMs, durationWords)}
      />
      <StatCard
        icon={ArrowsCounterClockwiseIcon}
        title="Turns"
        subtitle={subtitle}
        value={countWords(insights.turns)}
        footer={[
          { label: 'Tool calls', value: counted(insights.toolCalls) },
          { label: 'Subagents', value: counted(insights.subagents) },
        ]}
        {...chartOf('Turns', series.turns, countWords)}
      />
      <StatCard
        icon={TextAlignLeftIcon}
        title="Tokens out"
        subtitle={subtitle}
        value={countWords(tokens.output)}
        footer={[
          { label: 'Tokens in', value: countWords(tokens.input) },
          { label: 'Cache write', value: countWords(tokens.cacheWrite) },
        ]}
        {...chartOf('Tokens out', series.tokensOut, countWords)}
      />
      <StatCard
        icon={DatabaseIcon}
        title="Cache read share"
        subtitle={subtitle}
        value={percent(cacheShare(tokens))}
        footer={[
          { label: 'Cache read', value: countWords(tokens.cacheRead) },
          { label: 'Prompt total', value: countWords(tokens.cacheRead + tokens.input + tokens.cacheWrite) },
        ]}
        {...chartOf('Cache read share', cacheShares, (value) => `${value}%`)}
      />
    </div>
  )
}

function Attempts({ issue, now }: { issue: Issue; now: number }) {
  if (issue.sessions.length === 0)
    return <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">No attempt has started yet.</p>
  return (
    <ol className="flex flex-col text-[length:var(--vx-text-sm)]">
      {issue.sessions.map((session, index) => (
        <li key={session.id} className="flex items-start gap-6 py-3 not-first:border-t">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">Attempt {index + 1}</span>
              <Lozenge tone={SESSION_TONES[session.state]}>{SESSION_STATE_WORDS[session.state]}</Lozenge>
              {session.wait ? (
                <span className="text-muted-foreground">waiting for {session.wait.replaceAll('_', ' ')}</span>
              ) : null}
              <span className="text-xs text-muted-foreground tabular-nums">Turn {session.turn}</span>
              {session.model ? <span className="font-mono text-xs text-muted-foreground">{session.model}</span> : null}
              <span className="text-xs text-muted-foreground">
                Last activity <Ago iso={session.lastActivityAt} now={now} className="font-mono" />
              </span>
            </div>
            {session.summary ? <p className="line-clamp-2">{session.summary}</p> : null}
          </div>
          <dl className="hidden shrink-0 grid-cols-3 gap-x-5 text-right sm:grid">
            {[
              ['Working time', spanWords(session.insights.workingMs)],
              ['Tokens in', countWords(session.insights.tokens.input)],
              ['Tokens out', countWords(session.insights.tokens.output)],
            ].map(([label, value]) => (
              <div key={label} className="min-w-20">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-mono text-xs tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  )
}

/** A signal's title and text as plain text; a long text is clamped to four lines until asked for. */
function SignalText({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > 280 || text.split('\n').length > 4
  return (
    <div className="flex max-w-[75ch] flex-col items-start gap-1">
      <p className={all || !long ? 'whitespace-pre-wrap' : 'line-clamp-4 whitespace-pre-wrap'}>{text}</p>
      {long ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="cursor-pointer rounded-md text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  )
}

function Triage({ issue, now }: { issue: Issue; now: number }) {
  if (issue.triage.length === 0)
    return <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">Filed directly, not from a signal.</p>
  return (
    <ol className="flex flex-col text-[length:var(--vx-text-sm)]">
      {issue.triage.map((line, index) => (
        <li key={`${line.at}|${line.title}|${line.text}`} className="flex flex-col gap-1 py-3 not-first:border-t">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">
              {index === 0 ? 'Filed by' : 'Amended by'} {originWords(line.origin).toLowerCase()}
            </span>
            <span className="text-xs text-muted-foreground">
              {triageKindWords(line.kind)}, {trustWords(line.trust)}
            </span>
            {line.source ? <span className="font-mono text-xs text-muted-foreground">{line.source}</span> : null}
            <Ago iso={line.at} now={now} className="font-mono text-xs text-muted-foreground" />
          </div>
          {line.title ? <p className="max-w-[75ch] font-medium">{line.title}</p> : null}
          {line.text ? <SignalText text={line.text} /> : null}
          <SourceLink href={line.link}>Open the source</SourceLink>
        </li>
      ))}
    </ol>
  )
}

export function Overview({ issue, now }: { issue: Issue; now: number }) {
  // the summary is in the header, and an `about` that only repeats the title says nothing
  const about = issue.about && issue.about !== issue.title && issue.about !== issue.filedTitle ? issue.about : null
  return (
    <div className="flex flex-col gap-8">
      {about ? (
        <Section title="What it is">
          <p className="max-w-[75ch] text-[length:var(--vx-text-sm)]">{about}</p>
        </Section>
      ) : null}
      <Figures issue={issue} />
      <Section title="Attempts" hint="attempt" aside={<span className="tabular-nums">{issue.sessions.length}</span>}>
        <Attempts issue={issue} now={now} />
      </Section>
      <Section title="How it came to be">
        <Triage issue={issue} now={now} />
      </Section>
    </div>
  )
}
