import type { NeedItem } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { annotateArtifact, answerDecision, finishErrand, dismissSignal, giveVerdict, promoteSignal } from '@/lib/api'
import { ARTIFACT_KIND_LABEL, defaultWords, reversibleWords, VERDICTS } from '@/lib/needs'
import { useArtifact, useDecision, useErrands } from '@/lib/queries'
import { useSettle } from '@/lib/settle'

/** What every body gets: the item, and what to say once the lead (or the factory) has the answer. */
export interface BodyProps {
  item: NeedItem
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

const Loading = () => <p className="text-sm text-muted-foreground">Loading</p>

function DecisionBody({ item, onSent }: BodyProps) {
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
  return (
    <div className="grid gap-4">
      <p className="font-heading text-base font-semibold">{data.question}</p>
      <div className="grid gap-1 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recommendation</span>
        <p className="text-base font-semibold">{data.recommendation}</p>
      </div>
      <Labelled label="What was checked">
        <Prose>{data.checked}</Prose>
      </Labelled>
      <Labelled label="Options">
        <ul className="grid gap-2">
          {data.options.map((option) => (
            <li key={option.label} className="rounded-lg border px-3 py-2 text-sm">
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground"> - {reversibleWords(option.reversible)}</span>
              <p className="text-muted-foreground">{option.cost}</p>
            </li>
          ))}
        </ul>
      </Labelled>
      <Labelled label="With no answer">
        <Prose>{data.noAnswer.consequence}</Prose>
        {data.defaultAt && data.noAnswer.default ? (
          <p className="text-sm text-muted-foreground">
            {defaultWords(data.defaultAt, Date.now())}: {data.noAnswer.default}
          </p>
        ) : null}
      </Labelled>
      {open ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            <Button disabled={settle.disabled} onClick={() => answerWith(data.recommendation)}>
              Take the recommendation
            </Button>
            {data.options.map((option) => (
              <Button
                key={option.label}
                variant="outline"
                disabled={settle.disabled}
                onClick={() => answerWith(option.label)}
              >
                {option.label}
              </Button>
            ))}
          </div>
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
        </div>
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
      <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 font-sans text-sm whitespace-pre-wrap">
        {data.content}
      </pre>
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

function ErrandBody({ item, onSent }: BodyProps) {
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
      <Prose>{errand?.summary ?? item.summary}</Prose>
      {errand?.detail ? (
        <Labelled label="Detail">
          <Prose>{errand.detail}</Prose>
        </Labelled>
      ) : null}
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

function HeldSignalBody({ item, onSent }: BodyProps) {
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
  return (
    <div className="grid gap-4">
      <Prose>{item.summary}</Prose>
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
