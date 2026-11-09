import type { NeedItem } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { InfoHint, Lozenge, PropertyList } from '@/components/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { annotateArtifact, answerDecision, finishErrand, dismissSignal, giveVerdict, promoteSignal } from '@/lib/api'
import { originWord } from '@/lib/flow'
import {
  agoWords,
  ARTIFACT_KIND_LABEL,
  decisionParts,
  repeatsTitle,
  defaultLine,
  defaultWords,
  httpLink,
  issueNumber,
  optionIndex,
  projectOf,
  reversibleLozenge,
  VERDICTS,
} from '@/lib/needs'
import { artifactPreview, plainExcerpt } from '@/lib/plain'
import { useArtifact, useDecision, useErrands } from '@/lib/queries'
import { useSettle } from '@/lib/settle'
import { cn } from '@/lib/utils'

/** What every body gets: the item, and what to say once the lead (or the factory) has the answer. */
export interface BodyProps {
  item: NeedItem
  /** the Issue's title where the Issue is known */
  issueTitle: string | null
  onSent: (message: string) => void
}

const SENT = 'Sent to the lead'
const SETTLED = 'Already settled elsewhere'

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h4>
      {children}
    </section>
  )
}

const Prose = ({ children }: { children: ReactNode }) => <p className="text-sm whitespace-pre-wrap">{children}</p>

const Problem = ({ words }: { words: string | null }) =>
  words ? (
    <p role="alert" className="text-sm text-destructive">
      {words}
    </p>
  ) : null

/** The one line that says what this kind of thing is, with the word's definition beside it. */
const Lead = ({ hint, children }: { hint: 'decision' | 'errand' | 'held signal'; children: ReactNode }) => (
  <p className="flex items-center gap-0.5 text-sm text-muted-foreground">
    <span>{children}</span>
    <InfoHint word={hint} />
  </p>
)

const LINK = 'w-fit text-primary underline underline-offset-4'

/** The Issue link, or null so a PropertyList reads "None" (an element would always count as a value). */
const issueLink = (item: NeedItem, issueTitle: string | null): ReactNode =>
  item.issue ? (
    <Link to="/issues/$id" params={{ id: issueNumber(item.issue) }} className={LINK}>
      {issueTitle ?? 'Open Issue'}
    </Link>
  ) : null

const projectLink = (item: NeedItem): ReactNode =>
  item.repo === null ? (
    projectOf(item)
  ) : (
    <Link to="/flow" search={{ project: item.repo }} className={LINK}>
      {item.repo}
    </Link>
  )

/** A time as "2 hours ago" with the absolute time on hover. */
const When = ({ item }: Pick<BodyProps, 'item'>) => (
  <time className="font-mono tabular-nums" dateTime={item.since} title={new Date(item.since).toLocaleString()}>
    {agoWords(item.ageMs)}
  </time>
)

/** What the screen (the Judge's look at an Errand or a held signal) said about it. */
const ScreenNote = ({ note }: { note: string | null }) =>
  note ? (
    <section className="grid gap-1">
      <h4 className="flex items-center gap-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        What the screen said
        <InfoHint word="screen" />
      </h4>
      <Prose>{note}</Prose>
    </section>
  ) : null

const Loading = () => <p className="text-sm text-muted-foreground">Loading</p>

function DecisionBody({ item, issueTitle, onSent }: BodyProps) {
  const { data } = useDecision(item.id)
  const [text, setText] = useState('')
  const settle = useSettle<string>({
    send: (answer) => answerDecision(item.id, answer),
    keys: [['needs'], ['decision', item.id]],
    onSent: () => onSent(SENT),
    onConflict: () => onSent(SETTLED),
  })
  if (!data) return <Loading />
  const open = data.status === 'open'
  const answerWith = (answer: string) => settle.send(answer)
  const recommended = optionIndex(data.options, data.recommendation)
  const defaultOption = data.defaultAt && data.noAnswer.default ? optionIndex(data.options, data.noAnswer.default) : -1
  const now = Date.now()
  const narration = decisionParts(projectOf(item), issueTitle)
  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <Lead hint="decision">
          {narration.before}
          {narration.issue && item.issue ? (
            <Link to="/issues/$id" params={{ id: issueNumber(item.issue) }} className={LINK}>
              {narration.issue}
            </Link>
          ) : null}
          {narration.after}
        </Lead>
        {item.judge ? (
          <>
            <p className="flex items-center gap-0.5 text-sm text-muted-foreground">
              <span>The Judge looked at this first and passed it on</span>
              <InfoHint word="judge" />
            </p>
            <Prose>{item.judge}</Prose>
          </>
        ) : null}
        {item.artifact ? (
          <p className="text-sm text-muted-foreground">Raised about its artifact under review.</p>
        ) : null}
      </div>
      {repeatsTitle(data.question, item.title) ? null : (
        <p className="font-heading text-lg font-semibold">{data.question}</p>
      )}
      {recommended === -1 && data.recommendation.trim() ? (
        <div className="grid gap-2 rounded-xl bg-muted/50 px-4 py-3">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recommendation</span>
          <p className="text-base font-semibold">{data.recommendation}</p>
          {data.checked ? <Prose>{data.checked}</Prose> : null}
          {open ? (
            <div>
              <Button disabled={settle.disabled} onClick={() => answerWith(data.recommendation)}>
                Take the recommendation
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
        {data.options.map((option, index) => {
          const isRecommended = index === recommended
          const lozenge = reversibleLozenge(option.reversible)
          return (
            <li
              key={option.label}
              data-recommended={isRecommended}
              className={cn(
                'flex flex-col gap-3 rounded-xl p-4',
                isRecommended ? 'bg-primary/8 ring-1 ring-primary/40' : 'bg-muted/40',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                {isRecommended ? <Lozenge state="working">Recommended</Lozenge> : null}
                <Lozenge state={lozenge.state}>{lozenge.words}</Lozenge>
              </div>
              <p className="text-base font-semibold">{option.label}</p>
              <p className="text-sm text-muted-foreground">{option.cost}</p>
              {isRecommended && data.checked ? (
                <p className="text-sm">
                  <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Reason </span>
                  {data.checked}
                </p>
              ) : null}
              {index === defaultOption && data.defaultAt ? (
                <p className="text-sm text-muted-foreground">
                  {defaultLine(data.noAnswer.consequence, data.defaultAt, now)}
                </p>
              ) : null}
              {open ? (
                <div className="mt-auto pt-1">
                  <Button
                    variant={isRecommended ? 'default' : 'outline'}
                    disabled={settle.disabled}
                    onClick={() => answerWith(option.label)}
                  >
                    {isRecommended ? 'Take the recommendation' : `Choose ${option.label}`}
                  </Button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {defaultOption === -1 ? (
        <Labelled label="With no answer">
          <Prose>{data.noAnswer.consequence}</Prose>
          {data.defaultAt && data.noAnswer.default ? (
            <p className="text-sm text-muted-foreground">
              {defaultWords(data.defaultAt, now)}: {data.noAnswer.default}
            </p>
          ) : null}
        </Labelled>
      ) : null}
      {open ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim()) answerWith(text.trim())
          }}
        >
          <Textarea
            aria-label="Your own answer"
            placeholder="Or answer in your own words"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div>
            <Button type="submit" variant="secondary" disabled={settle.disabled || !text.trim()}>
              Send answer
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{SETTLED}</p>
      )}
      <Problem words={settle.error} />
    </div>
  )
}

function ReviewBody({ item, onSent }: BodyProps) {
  const { data } = useArtifact(item.id)
  const [note, setNote] = useState('')
  const [quote, setQuote] = useState('')
  const [comment, setComment] = useState('')
  const [commented, setCommented] = useState(false)
  const keys = [['needs'], ['artifact', item.id]]
  const verdict = useSettle<string>({
    send: (value) => giveVerdict(item.id, value, note.trim()),
    keys,
    onSent: () => onSent(SENT),
    onConflict: () => onSent(SETTLED),
  })
  const annotate = useSettle<void>({
    send: () => annotateArtifact(item.id, quote.trim(), comment.trim()),
    keys: [['artifact', item.id]],
    onSent: () => {
      setQuote('')
      setComment('')
      setCommented(true)
    },
  })
  if (!data) return <Loading />
  const remarks = [...data.annotations, ...data.unanchored]
  const preview = artifactPreview(data.artifact.format, data.content)
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {ARTIFACT_KIND_LABEL[data.artifact.kind] ?? data.artifact.kind}
        </span>
        <p className="font-heading text-base font-semibold">{data.artifact.title}</p>
        <Link
          to="/artifacts/$id"
          params={{ id: data.artifact.id }}
          className="w-fit text-sm text-primary underline underline-offset-4"
        >
          Open the full page
        </Link>
      </div>
      {preview ? <p className="max-w-[75ch] text-sm text-muted-foreground">{preview}</p> : null}
      {remarks.length > 0 ? (
        <Labelled label="Comments">
          <ul className="grid gap-2">
            {remarks.map((remark) => (
              <li key={remark.id} className="rounded-lg border px-3 py-2 text-sm">
                <p className="text-muted-foreground">
                  {remark.author === 'owner' ? 'You' : 'Lead'} on "{remark.quote}"
                </p>
                <p className="whitespace-pre-wrap">{remark.comment}</p>
              </li>
            ))}
          </ul>
        </Labelled>
      ) : null}
      <Labelled label="Your verdict">
        <Textarea
          aria-label="Note for the verdict"
          placeholder="A note for the lead (needed for With notes and Changes)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex flex-wrap gap-2 pt-1">
          {VERDICTS.map((entry) => (
            <Button
              key={entry.value}
              variant={entry.value === 'looks_good' ? 'default' : 'outline'}
              disabled={verdict.disabled || (entry.needsNote && !note.trim())}
              onClick={() => verdict.send(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <Problem words={verdict.error} />
      </Labelled>
      <Labelled label="Comment on a passage">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setCommented(false)
            annotate.send()
          }}
        >
          <Input
            aria-label="Passage"
            placeholder="Passage (copy the words you mean)"
            value={quote}
            onChange={(event) => setQuote(event.target.value)}
          />
          <Textarea
            aria-label="Comment"
            placeholder="Comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" disabled={annotate.disabled || !quote.trim() || !comment.trim()}>
              Add comment
            </Button>
            {commented ? (
              <span role="status" className="text-sm text-muted-foreground">
                Comment saved
              </span>
            ) : null}
          </div>
          <Problem words={annotate.error} />
        </form>
      </Labelled>
    </div>
  )
}

function ErrandBody({ item, issueTitle, onSent }: BodyProps) {
  const { data } = useErrands()
  const [note, setNote] = useState('')
  const settle = useSettle<void>({
    send: () => finishErrand(item.id, note.trim()),
    keys: [['needs'], ['errands']],
    onSent: () => onSent(SENT),
    onConflict: () => onSent(SETTLED),
  })
  const errand = data?.errands.find((entry) => entry.id === item.id)
  return (
    <div className="grid gap-4">
      <Lead hint="errand">
        Something only your hands can do - a device, a portal, a physical step. The lead cannot do it and waits.
      </Lead>
      <Prose>{errand?.summary ?? item.title}</Prose>
      {errand?.detail ? (
        <Labelled label="Detail">
          <Prose>{errand.detail}</Prose>
        </Labelled>
      ) : null}
      <PropertyList
        items={[
          { label: 'Issue', value: issueLink(item, issueTitle) },
          { label: 'Project', value: projectLink(item) },
          { label: 'Raised', value: <When item={item} /> },
        ]}
      />
      <ScreenNote note={item.judge} />
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          settle.send()
        }}
      >
        <Input
          aria-label="Note"
          placeholder="A note for the lead (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div>
          <Button type="submit" disabled={settle.disabled}>
            Done
          </Button>
        </div>
      </form>
      <Problem words={settle.error} />
    </div>
  )
}

function HeldSignalBody({ item, issueTitle, onSent }: BodyProps) {
  const [repo, setRepo] = useState('')
  const settle = useSettle<void>({
    send: () => promoteSignal(item.id, item.repo ?? repo.trim()),
    keys: [['needs']],
    onSent: () => onSent('Promoted: it is work now'),
    onConflict: () => onSent(SETTLED),
  })
  const [reason, setReason] = useState('')
  const dismissal = useSettle<void>({
    send: () => dismissSignal(item.id, reason.trim()),
    keys: [['needs']],
    onSent: () => onSent('Dismissed: it stays on record'),
    onConflict: () => onSent(SETTLED),
  })
  const needsRepo = item.repo === null
  const link = httpLink(item.sourceLink)
  return (
    <div className="grid gap-4">
      <Lead hint="held signal">Outside text the factory did not trust enough to turn into work</Lead>
      <Prose>{plainExcerpt(item.summary)}</Prose>
      <PropertyList
        items={[
          { label: 'Source', value: sourceWords(item) },
          {
            label: 'Link to the source',
            value: link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className={LINK}>
                Open the source
              </a>
            ) : null,
          },
          { label: 'Project', value: projectLink(item) },
          { label: 'Received', value: <When item={item} /> },
          { label: 'Issue', value: issueLink(item, issueTitle) },
        ]}
      />
      <ScreenNote note={item.judge} />
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          settle.send()
        }}
      >
        {needsRepo ? (
          <Input
            aria-label="Repository"
            placeholder="Which repository is this for?"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
        ) : null}
        <div>
          <Button type="submit" disabled={settle.disabled || (needsRepo && !repo.trim())}>
            Promote
          </Button>
        </div>
      </form>
      <Problem words={settle.error} />
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          dismissal.send()
        }}
      >
        <Input
          aria-label="Reason"
          placeholder="Why turn it away?"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <div>
          <Button type="submit" variant="outline" disabled={dismissal.disabled || !reason.trim()}>
            Dismiss
          </Button>
        </div>
      </form>
      <Problem words={dismissal.error} />
    </div>
  )
}

/** "an uptime check, Infrastructure": the source in a person's word and the origin as Flow words it. */
function sourceWords(item: NeedItem): string {
  const origin = item.origin ? originWord(item.origin) : null
  if (!item.source) return origin ?? 'Unknown'
  if (!origin || origin.toLowerCase() === item.source.toLowerCase()) return item.source
  return `${item.source}, ${origin}`
}

export function BodyOf(props: BodyProps) {
  switch (props.item.kind) {
    case 'decision':
      return <DecisionBody {...props} />
    case 'review':
      return <ReviewBody {...props} />
    case 'errand':
      return <ErrandBody {...props} />
    case 'held_signal':
      return <HeldSignalBody {...props} />
  }
}
