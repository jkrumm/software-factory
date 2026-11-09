import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ArtifactDetail } from '@software-factory/contract'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { postAnnotation, postVerdict } from '@/lib/api'
import { ageWords } from '@/lib/age'
import { GLOBAL_PATH, groupAnnotations, normalizeQuote, VERDICT_WORDS } from '@/lib/artifact'
import { cn } from '@/lib/utils'
import type { Selected } from '@/components/artifact-content'

type Annotation = ArtifactDetail['annotations'][number]

const ago = (iso: string) => ageWords(Date.now() - Date.parse(iso))

/** Refetches the artifact's queries after a write; the stream does the same for every other screen. */
function useWrite<V>(id: string, send: (value: V) => Promise<unknown>, done?: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: send,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['artifact', id] })
      done?.()
    },
  })
}

function Failure({ error }: { error: Error | null }) {
  if (!error) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      Could not save: {error.message}
    </p>
  )
}

/** The comment box for a selection: it posts the quote and its heading path for the revision shown. */
export function Composer({
  id,
  revision,
  selected,
  onDone,
}: {
  id: string
  revision: number
  selected: Selected
  onDone: () => void
}) {
  const [comment, setComment] = useState('')
  const write = useWrite(
    id,
    () =>
      postAnnotation(id, {
        revision,
        quote: selected.quote,
        ...(selected.path ? { path: selected.path } : {}),
        comment: comment.trim(),
      }),
    onDone,
  )
  return (
    <form
      aria-label="Comment on the selection"
      className="fixed inset-x-3 bottom-20 z-30 flex flex-col gap-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg md:inset-x-auto md:right-6 md:bottom-6 md:w-96"
      onSubmit={(event) => {
        event.preventDefault()
        if (comment.trim() !== '') write.mutate(undefined)
      }}
    >
      <p className="line-clamp-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{selected.quote}</p>
      <Textarea
        aria-label="Comment"
        autoFocus
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Your comment"
      />
      <Failure error={write.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={comment.trim() === '' || write.isPending}>
          Add comment
        </Button>
      </div>
    </form>
  )
}

function AnnotationItem({ annotation, onFocus }: { annotation: Annotation; onFocus?: (quote: string) => void }) {
  const isGeneral = annotation.path === GLOBAL_PATH
  const body = (
    <>
      {isGeneral ? null : (
        <span className="line-clamp-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {annotation.quote}
        </span>
      )}
      <span className="text-sm">{annotation.comment}</span>
      <span className="text-xs text-muted-foreground">
        {annotation.author === 'lead' ? 'The lead' : 'You'}
        {annotation.path && !isGeneral ? ` · ${annotation.path}` : ''} · revision {annotation.revision} ·{' '}
        {ago(annotation.at)}
      </span>
    </>
  )
  const style = 'flex w-full flex-col gap-1 rounded-lg border bg-card p-3 text-left'
  if (!onFocus) return <li className={style}>{body}</li>
  return (
    <li>
      <button type="button" className={cn(style, 'hover:bg-accent')} onClick={() => onFocus(annotation.quote)}>
        {body}
      </button>
    </li>
  )
}

function Group({
  title,
  note,
  items,
  onFocus,
}: {
  title: string
  note?: string
  items: readonly Annotation[]
  onFocus?: (quote: string) => void
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({items.length})</span>
      </h3>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((annotation) => (
          <AnnotationItem key={annotation.id} annotation={annotation} onFocus={onFocus} />
        ))}
      </ul>
    </section>
  )
}

/** A comment on the artifact as a whole: the API wants a quote, so it hangs on the title with the path `global`. */
function GeneralComment({ detail }: { detail: ArtifactDetail }) {
  const [comment, setComment] = useState('')
  const write = useWrite(
    detail.artifact.id,
    () =>
      postAnnotation(detail.artifact.id, {
        revision: detail.revision,
        quote: normalizeQuote(detail.artifact.title),
        path: GLOBAL_PATH,
        comment: comment.trim(),
      }),
    () => setComment(''),
  )
  return (
    <form
      aria-label="General comment"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (comment.trim() !== '') write.mutate(undefined)
      }}
    >
      <Textarea
        aria-label="General comment"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="A comment on the whole artifact"
      />
      <Failure error={write.error} />
      <Button type="submit" variant="outline" className="self-end" disabled={comment.trim() === '' || write.isPending}>
        Add general comment
      </Button>
    </form>
  )
}

export function Annotations({ detail, onFocus }: { detail: ArtifactDetail; onFocus: (quote: string) => void }) {
  const groups = groupAnnotations(detail.annotations, detail.unanchored)
  const none = groups.general.length + groups.anchored.length + groups.unanchored.length === 0
  return (
    <div className="flex flex-col gap-5">
      <h2 className="font-heading text-lg font-semibold">Comments</h2>
      <p className="text-xs text-muted-foreground">Select text in the artifact to comment on it.</p>
      {none ? <p className="text-sm text-muted-foreground">No comments yet.</p> : null}
      <Group title="General" items={groups.general} />
      <Group title="On the text" items={groups.anchored} onFocus={onFocus} />
      <Group title="Unanchored" note="Their text is no longer in this revision." items={groups.unanchored} />
      <GeneralComment detail={detail} />
    </div>
  )
}

/** The owner's verdict on the revision shown: four words and an optional note. Once given, it shows with its time. */
export function Verdict({ detail }: { detail: ArtifactDetail }) {
  const given = detail.verdicts.find((verdict) => verdict.revision === detail.revision)
  const [choice, setChoice] = useState<keyof typeof VERDICT_WORDS | null>(null)
  const [note, setNote] = useState('')
  const write = useWrite(detail.artifact.id, (verdict: keyof typeof VERDICT_WORDS) =>
    postVerdict(detail.artifact.id, {
      verdict,
      revision: detail.revision,
      ...(note.trim() ? { note: note.trim() } : {}),
    }),
  )

  if (given) {
    return (
      <section aria-label="Verdict" className="flex flex-col gap-1 rounded-xl border bg-card p-3">
        <h2 className="font-heading text-lg font-semibold">Verdict</h2>
        <p className="text-sm">
          {VERDICT_WORDS[given.verdict]} · {ago(given.at)}
        </p>
        {given.note ? <p className="text-sm text-muted-foreground">{given.note}</p> : null}
      </section>
    )
  }
  const latest = detail.artifact.revisions.at(-1)?.n
  if (latest !== undefined && detail.revision !== latest) {
    return (
      <section aria-label="Verdict" className="flex flex-col gap-1 rounded-xl border bg-card p-3">
        <h2 className="font-heading text-lg font-semibold">Verdict</h2>
        <p className="text-sm text-muted-foreground">A verdict is given on the latest revision ({latest}).</p>
      </section>
    )
  }
  return (
    <section aria-label="Verdict" className="flex flex-col gap-2 rounded-xl border bg-card p-3">
      <h2 className="font-heading text-lg font-semibold">Verdict</h2>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(VERDICT_WORDS) as Array<keyof typeof VERDICT_WORDS>).map((verdict) => (
          <Button
            key={verdict}
            type="button"
            variant={choice === verdict ? 'default' : 'outline'}
            aria-pressed={choice === verdict}
            onClick={() => setChoice(verdict)}
          >
            {VERDICT_WORDS[verdict]}
          </Button>
        ))}
      </div>
      <Textarea
        aria-label="Verdict note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="A note (optional)"
      />
      <Failure error={write.error} />
      <Button
        type="button"
        disabled={choice === null || write.isPending}
        onClick={() => choice && write.mutate(choice)}
      >
        Send verdict
      </Button>
    </section>
  )
}
