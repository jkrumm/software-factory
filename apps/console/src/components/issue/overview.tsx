import { ArrowsCounterClockwiseIcon, DatabaseIcon, TextAlignLeftIcon, TimerIcon } from '@phosphor-icons/react'
import type { ReadIssueDetail } from '@software-factory/contract'
import { useState } from 'react'
import { Lozenge } from '@/components/kit/lozenge'
import { MiniBars } from '@/components/kit/mini-bars'
import { Section } from '@/components/kit/section'
import { StatCard } from '@/components/kit/stat-card'
import { durationWords } from '@/components/kit/step-rail'
import { countWords, originWords, SESSION_STATE_WORDS, triageKindWords, trustWords } from '@/lib/issue'
import {
  attemptSeries,
  cacheShare,
  SESSION_TONES,
  TOKENS_NOT_COUNTED,
  TOOL_CALLS_NOT_COUNTED,
  tokensCounted,
  toolCallsCounted,
  triageAt,
} from '@/lib/issue-page'
import { spanWords } from '@/lib/needs'
import { aboutLine, type SignalPart, signalParts, sourceLabel } from '@/lib/plain'
import { Ago } from './ago'
import { SourceLink } from './source-link'

type Issue = ReadIssueDetail

/** A share as a percent; null (no prompt tokens) is `null` so the card draws its dash, never a word. */
const percent = (share: number | null): string | null => (share === null ? null : `${Math.round(share * 100)}%`)

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
  const tokensOk = tokensCounted(insights)
  const callsOk = toolCallsCounted(insights)
  /** A token figure, or the dash when the factory has not counted tokens. */
  const token = (value: number): string | null => (tokensOk ? countWords(value) : null)
  const calls = (value: number): string | null => (callsOk ? countWords(value) : null)
  const share = percent(cacheShare(tokens))
  const cacheShares = sessions.map((s) => Math.round((cacheShare(s.insights.tokens) ?? 0) * 100))
  const subtitle = many ? 'Per attempt' : 'This attempt'
  /** Bars per attempt with the attempts under them; one attempt has nothing to compare, so no chart. */
  const chartOf = (name: string, values: number[], format: (value: number) => string, counted = true) =>
    many && counted
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
          { label: 'Tool calls', value: calls(insights.toolCalls), note: TOOL_CALLS_NOT_COUNTED },
          { label: 'Subagents', value: calls(insights.subagents), note: TOOL_CALLS_NOT_COUNTED },
        ]}
        {...chartOf('Turns', series.turns, countWords)}
      />
      <StatCard
        icon={TextAlignLeftIcon}
        title="Tokens out"
        subtitle={subtitle}
        value={token(tokens.output)}
        valueNote={TOKENS_NOT_COUNTED}
        footer={[
          { label: 'Tokens in', value: token(tokens.input), note: TOKENS_NOT_COUNTED },
          { label: 'Cache write', value: token(tokens.cacheWrite), note: TOKENS_NOT_COUNTED },
        ]}
        {...chartOf('Tokens out', series.tokensOut, countWords, tokensOk)}
      />
      <StatCard
        icon={DatabaseIcon}
        title="Cache read share"
        subtitle={subtitle}
        value={tokensOk ? share : null}
        valueNote={tokensOk ? 'No prompt tokens were counted.' : TOKENS_NOT_COUNTED}
        footer={[
          { label: 'Cache read', value: token(tokens.cacheRead), note: TOKENS_NOT_COUNTED },
          {
            label: 'Prompt total',
            value: token(tokens.cacheRead + tokens.input + tokens.cacheWrite),
            note: TOKENS_NOT_COUNTED,
          },
        ]}
        {...chartOf('Cache read share', cacheShares, (value) => `${value}%`, tokensOk && share !== null)}
      />
    </div>
  )
}

/** A session's token figure, or null when that session's tokens are uncounted. */
const tokensOf = (insights: Issue['sessions'][number]['insights'], value: number): string | null =>
  tokensCounted(insights) ? countWords(value) : null

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
              { label: 'Working time', value: durationWords(session.insights.workingMs) },
              { label: 'Tokens in', value: tokensOf(session.insights, session.insights.tokens.input) },
              { label: 'Tokens out', value: tokensOf(session.insights, session.insights.tokens.output) },
            ].map(({ label, value }) => (
              <div key={label} className="min-w-20">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-mono text-xs tabular-nums" title={value === null ? TOKENS_NOT_COUNTED : undefined}>
                  {value ?? '–'}
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  )
}

/** A signal's words with its times as "5 min ago" (the absolute time on hover). */
function Parts({ parts, now }: { parts: SignalPart[]; now: number }) {
  return parts.map((part, index) =>
    part.kind === 'time' ? (
      <Ago key={`${index}|${part.iso}`} iso={part.iso} now={now} />
    ) : (
      <span key={`${index}|${part.text}`}>{part.text}</span>
    ),
  )
}

/** A signal's text; a long one is clamped to four lines until asked for. */
function SignalText({ parts, now }: { parts: SignalPart[]; now: number }) {
  const [all, setAll] = useState(false)
  const plain = parts.map((part) => (part.kind === 'text' ? part.text : '10 min ago')).join('')
  const long = plain.length > 280 || plain.split('\n').length > 4
  return (
    <div className="flex max-w-[75ch] flex-col items-start gap-1">
      <p className={all || !long ? 'whitespace-pre-wrap' : 'line-clamp-4 whitespace-pre-wrap'}>
        <Parts parts={parts} now={now} />
      </p>
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
      {issue.triage.map((line, index) => {
        const source = sourceLabel(line.source)
        const title = signalParts(line.title)
        const text = signalParts(line.text)
        return (
          <li key={`${line.at}|${line.title}|${line.text}`} className="flex flex-col gap-1 py-3 not-first:border-t">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">
                {index === 0 ? 'Filed by' : 'Amended by'} {originWords(line.origin).toLowerCase()}
              </span>
              <span className="text-xs text-muted-foreground">
                {triageKindWords(line.kind)}, {trustWords(line.trust)}
              </span>
              {source ? <span className="text-xs text-muted-foreground">{source}</span> : null}
              <Ago iso={triageAt(issue, index)} now={now} className="font-mono text-xs text-muted-foreground" />
            </div>
            {title.length > 0 ? (
              <p className="max-w-[75ch] font-medium">
                <Parts parts={title} now={now} />
              </p>
            ) : null}
            {text.length > 0 ? <SignalText parts={text} now={now} /> : null}
            <SourceLink href={line.link}>Open the source</SourceLink>
          </li>
        )
      })}
    </ol>
  )
}

export function Overview({ issue, now }: { issue: Issue; now: number }) {
  // the summary is in the header; an `about` that repeats the title or is a cut fragment says nothing
  const about = aboutLine(issue.about, issue.title, issue.filedTitle)
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
