import type { ReadIssueDetail } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { Lozenge } from '@/components/kit/lozenge'
import { Section } from '@/components/kit/section'
import type { Tone } from '@/components/kit/tone'
import { askStatusWords, deliveryWords, settledByWords, verdictWords } from '@/lib/issue'
import { ASK_TONES, type OptionChip, optionChips } from '@/lib/issue-page'
import { ARTIFACT_KIND_LABEL } from '@/lib/needs'
import { Ago } from './ago'
import { LINK_CLASS } from './source-link'

type Issue = ReadIssueDetail
type Ask = Issue['asks'][number]

const CHIP_TONES: Record<OptionChip, Tone> = { Recommended: 'accent', Default: 'neutral', Answer: 'good' }

const EMPTY = 'text-[length:var(--vx-text-sm)] text-muted-foreground'

function Labelled({ label, children }: { label: string; children: string }) {
  return (
    <div className="max-w-[75ch]">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap">{children}</p>
    </div>
  )
}

function AskBlock({ ask, now }: { ask: Ask; now: number }) {
  return (
    <li className="flex flex-col gap-3 py-4 not-first:border-t first:pt-0">
      <p className="max-w-[75ch] font-medium">{ask.question}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Lozenge tone={ASK_TONES[ask.status]}>{askStatusWords(ask.status)}</Lozenge>
        <span>
          Asked <Ago iso={ask.askedAt} now={now} className="font-mono" />
        </span>
        {ask.answeredAt ? (
          <span>
            Settled <Ago iso={ask.answeredAt} now={now} className="font-mono" /> {settledByWords(ask.settledBy)}
          </span>
        ) : null}
      </div>
      {ask.options.length > 0 ? (
        <ul className="flex flex-col">
          {ask.options.map((option) => (
            <li key={option} className="flex flex-wrap items-center gap-2 py-1.5 not-first:border-t">
              <span className="min-w-0">{option}</span>
              {optionChips(option, ask).map((chip) => (
                <Lozenge key={chip} tone={CHIP_TONES[chip]}>
                  {chip}
                </Lozenge>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {ask.recommendation &&
      !ask.options.some((option) => option.trim().toLowerCase() === ask.recommendation.trim().toLowerCase()) ? (
        <Labelled label="Recommendation">{ask.recommendation}</Labelled>
      ) : null}
      {ask.checked ? <Labelled label="Checked">{ask.checked}</Labelled> : null}
      {ask.status === 'open' ? (
        <Link to="/needs-you" search={{ item: ask.id }} className={LINK_CLASS}>
          Answer it on Needs you
        </Link>
      ) : null}
    </li>
  )
}

export function Checkpoints({ issue, now }: { issue: Issue; now: number }) {
  return (
    <div className="flex flex-col gap-8 text-[length:var(--vx-text-sm)]">
      <Section title="Decisions" hint="decision" aside={<span className="tabular-nums">{issue.asks.length}</span>}>
        {issue.asks.length === 0 ? (
          <p className={EMPTY}>The lead asked nothing.</p>
        ) : (
          <ul className="flex flex-col">
            {issue.asks.map((ask) => (
              <AskBlock key={ask.id} ask={ask} now={now} />
            ))}
          </ul>
        )}
      </Section>
      <Section
        title="Specs, Concepts and Reports"
        hint="artifact"
        aside={<span className="tabular-nums">{issue.artifacts.length}</span>}
      >
        {issue.artifacts.length === 0 ? (
          <p className={EMPTY}>No Concept, Spec or Report yet.</p>
        ) : (
          <ul className="flex flex-col">
            {issue.artifacts.map((artifact) => (
              <li key={artifact.id} className="not-first:border-t">
                <Link
                  to="/artifacts/$id"
                  params={{ id: artifact.id }}
                  className="-mx-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md px-2 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">{artifact.title}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {artifact.revisions} {artifact.revisions === 1 ? 'revision' : 'revisions'}
                  </span>
                  <span className="text-xs text-muted-foreground">{verdictWords(artifact.verdict)}</span>
                  <Ago iso={artifact.at} now={now} className="font-mono text-xs text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Notes you sent" aside={<span className="tabular-nums">{issue.notes.length}</span>}>
        {issue.notes.length === 0 ? (
          <p className={EMPTY}>You sent no note.</p>
        ) : (
          <ul className="flex flex-col">
            {issue.notes.map((note) => (
              <li key={`${note.at}|${note.text}`} className="flex flex-col gap-1 py-3 not-first:border-t first:pt-0">
                <p className="max-w-[75ch] whitespace-pre-wrap">{note.text}</p>
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <Ago iso={note.at} now={now} className="font-mono" />
                  <span>{deliveryWords(note.delivered)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
