import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactDetail } from '@software-factory/contract'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { deleteAnnotation, patchAnnotation, postAnnotation, postVerdict } from '@/lib/api'
import { ageWords } from '@/lib/age'
import { composerTop, GLOBAL_PATH, groupAnnotations, normalizeQuote, VERDICT_WORDS } from '@/lib/artifact'
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

function Failure({ error, what = 'save' }: { error: Error | null; what?: string }) {
  if (!error) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      Could not {what}: {error.message}
    </p>
  )
}

/**
 * The comment box for a selection: it posts the quote and its heading path for the revision shown. From `lg` it sits in
 * the comments column, level with the passage (`anchorTop`, a viewport coordinate) and kept on screen; below `lg` it
 * docks at the bottom of the screen.
 */
export function Composer({
  id,
  revision,
  selected,
  anchorTop,
  docked,
  onDone,
}: {
  id: string
  revision: number
  selected: Selected
  anchorTop: number
  docked: boolean
  onDone: () => void
}) {
  const [comment, setComment] = useState('')
  const box = useRef<HTMLFormElement>(null)
  const [top, setTop] = useState(8)
  useLayoutEffect(() => {
    const column = box.current?.offsetParent
    if (docked || !box.current || !column) return
    const { top: columnTop, height } = column.getBoundingClientRect()
    setTop(composerTop(anchorTop, { top: columnTop, height }, box.current.offsetHeight))
  }, [anchorTop, docked, comment])
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
      ref={box}
      aria-label="Comment on the selection"
      style={docked ? undefined : { top }}
      className={cn(
        'z-30 flex flex-col gap-2 bg-popover p-3 text-popover-foreground shadow-xl ring-1 ring-foreground/10',
        docked ? 'fixed inset-x-3 bottom-20 rounded-xl' : 'absolute inset-x-3 rounded-lg',
      )}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onDone()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (comment.trim() !== '') write.mutate(undefined)
      }}
    >
      <p className="line-clamp-3 text-sm text-muted-foreground italic">{selected.quote}</p>
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

const ACTION =
  'size-7 text-muted-foreground opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100'

/** One comment: the card scrolls its passage into view; edit (the owner's own) and delete (any) sit beside it, never inside it. */
function AnnotationItem({
  id,
  annotation,
  onFocus,
}: {
  id: string
  annotation: Annotation
  onFocus?: (quote: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [draft, setDraft] = useState(annotation.comment)
  const isGeneral = annotation.path === GLOBAL_PATH
  const mine = annotation.author === 'owner'
  const save = useWrite(
    id,
    () => patchAnnotation(id, annotation.id, draft.trim()),
    () => setMode('view'),
  )
  const remove = useWrite(id, () => deleteAnnotation(id, annotation.id))
  const leave = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    setMode('view')
  }

  const meta = (
    <span className="text-xs text-muted-foreground">
      {mine ? 'You' : 'The lead'}
      {annotation.path && !isGeneral ? ` · ${annotation.path}` : ''} · revision {annotation.revision} ·{' '}
      {ago(annotation.at)}
      {annotation.editedAt ? (
        <>
          {' · '}
          <span title={new Date(annotation.editedAt).toLocaleString()}>edited {ago(annotation.editedAt)}</span>
        </>
      ) : null}
    </span>
  )
  const body = (
    <>
      {isGeneral ? null : <span className="line-clamp-2 text-sm text-muted-foreground italic">{annotation.quote}</span>}
      <span className="text-sm whitespace-pre-wrap">{annotation.comment}</span>
      {meta}
    </>
  )
  const text = 'flex w-full flex-col gap-1 py-3 text-left'

  if (mode === 'edit')
    return (
      <li className="py-3">
        <form
          aria-label="Edit comment"
          className="flex flex-col gap-2"
          onKeyDown={leave}
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim() !== '' && draft.trim() !== annotation.comment) save.mutate(undefined)
          }}
        >
          <Textarea aria-label="Comment" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
          <Failure error={save.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={draft.trim() === '' || draft.trim() === annotation.comment || save.isPending}
            >
              Save
            </Button>
          </div>
        </form>
      </li>
    )

  return (
    <li className="group/item relative">
      {onFocus ? (
        <button
          type="button"
          className={cn(text, 'rounded-md pr-16 hover:bg-accent')}
          onClick={() => onFocus(annotation.quote)}
        >
          {body}
        </button>
      ) : (
        <div className={cn(text, 'pr-16')}>{body}</div>
      )}
      {mode === 'delete' ? (
        <div className="flex items-center gap-2 pb-3 text-sm" onKeyDown={leave}>
          <span className="mr-auto">Delete comment?</span>
          <Button type="button" variant="ghost" size="sm" autoFocus onClick={() => setMode('view')}>
            Keep
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(undefined)}
          >
            Delete
          </Button>
        </div>
      ) : (
        <div className="absolute top-2 right-0 flex">
          {mine ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ACTION}
              aria-label="Edit comment"
              onClick={() => {
                setDraft(annotation.comment)
                setMode('edit')
              }}
            >
              <PencilSimpleIcon />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ACTION}
            aria-label="Delete comment"
            onClick={() => setMode('delete')}
          >
            <TrashIcon />
          </Button>
        </div>
      )}
      {mode === 'delete' ? <Failure error={remove.error} what="delete" /> : null}
    </li>
  )
}

function Group({
  id,
  title,
  note,
  items,
  onFocus,
}: {
  id: string
  title: string
  note?: string
  items: readonly Annotation[]
  onFocus?: (quote: string) => void
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({items.length})</span>
      </h3>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <ul className="flex flex-col divide-y">
        {items.map((annotation) => (
          <AnnotationItem key={annotation.id} id={id} annotation={annotation} onFocus={onFocus} />
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
  const id = detail.artifact.id
  const none = groups.general.length + groups.anchored.length + groups.unanchored.length === 0
  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-heading text-base font-semibold tracking-tight">Comments</h2>
      <p className="text-xs text-muted-foreground">Select text in the artifact to comment on it.</p>
      <GeneralComment detail={detail} />
      {none ? <p className="text-sm text-muted-foreground">No comments yet.</p> : null}
      <Group id={id} title="General" items={groups.general} />
      <Group id={id} title="On the text" items={groups.anchored} onFocus={onFocus} />
      <Group id={id} title="Unanchored" note="Their text is no longer in this revision." items={groups.unanchored} />
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
      <section aria-label="Verdict" className="flex flex-col gap-1">
        <h2 className="font-heading text-base font-semibold tracking-tight">Verdict</h2>
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
      <section aria-label="Verdict" className="flex flex-col gap-1">
        <h2 className="font-heading text-base font-semibold tracking-tight">Verdict</h2>
        <p className="text-sm text-muted-foreground">A verdict is given on the latest revision ({latest}).</p>
      </section>
    )
  }
  return (
    <section aria-label="Verdict" className="flex flex-col gap-2">
      <h2 className="font-heading text-base font-semibold tracking-tight">Verdict</h2>
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
