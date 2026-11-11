import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChatCircleTextIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactDetail } from '@software-factory/contract'
import { Ago } from '@/components/issue/ago'
import { Lozenge } from '@/components/kit/lozenge'
import { TONE_TINT, type Tone } from '@/components/kit/tone'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { deleteAnnotation, patchAnnotation, postAnnotation, postVerdict } from '@/lib/api'
import {
  GLOBAL_PATH,
  groupAnnotations,
  normalizeQuote,
  POPOVER_WIDTH,
  popoverPosition,
  VERDICT_WORDS,
} from '@/lib/artifact'
import { cn } from '@/lib/utils'
import type { Selected } from '@/components/artifact-content'

type Annotation = ArtifactDetail['annotations'][number]

/** The comment the owner is on: which card is open and which passage to bring into view (`tick` repeats a click). */
export interface Focus {
  id: string
  quote: string
  tick: number
}

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

const SHADOW = { boxShadow: 'var(--vx-shadow-overlay)' }

/**
 * The comment box for a selection, a popover anchored to the passage: just below it (above when there is no room), on
 * its left edge, kept inside the viewport and following the passage when the page scrolls (`anchor` is a viewport
 * rect). Below `lg` it docks at the bottom of the screen instead, clear of a touch selection's handles.
 */
export function Composer({
  id,
  revision,
  selected,
  anchor,
  docked,
  onDone,
}: {
  id: string
  revision: number
  selected: Selected
  anchor: Selected['rect']
  docked: boolean
  onDone: () => void
}) {
  const [comment, setComment] = useState('')
  const box = useRef<HTMLFormElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (docked || !box.current) return
    const { offsetWidth: width, offsetHeight: height } = box.current
    setAt(popoverPosition(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [anchor, docked, comment])
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
      data-anchored={docked ? undefined : ''}
      style={docked ? SHADOW : { ...SHADOW, ...(at ?? { top: 0, left: 0 }), width: POPOVER_WIDTH }}
      className={cn(
        'z-50 flex flex-col gap-2.5 bg-popover p-3 text-popover-foreground',
        docked ? 'fixed inset-x-3 bottom-20 rounded-xl' : 'fixed max-w-[calc(100vw-1rem)] rounded-xl',
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
      <p className={cn('line-clamp-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground', TONE_TINT.neutral)}>
        “{selected.quote}”
      </p>
      <Textarea
        aria-label="Comment"
        autoFocus
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Your comment"
        className="min-h-20 text-[length:var(--vx-text-sm)]"
      />
      <Failure error={write.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={comment.trim() === '' || write.isPending}>
          Add comment
        </Button>
      </div>
    </form>
  )
}

const ACTION =
  'size-6 text-muted-foreground opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 data-[shown]:opacity-100'

/**
 * One comment as a card: who and when, the passage it quotes, the comment, where in the document. The card is a button
 * that brings its passage into view and paints it; edit (the owner's own) and delete (any) are its siblings, shown on
 * the open card, on hover and on focus, and work in place.
 */
function AnnotationItem({
  id,
  annotation,
  active,
  revision,
  now,
  onFocus,
}: {
  id: string
  annotation: Annotation
  active: boolean
  /** the revision shown: a comment made on another one says so */
  revision: number
  now: number
  onFocus?: (annotation: Annotation) => void
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
  const card = cn('group/item relative rounded-lg bg-background p-3 transition-shadow', active && 'bg-muted shadow-sm')

  const who = (
    <span className="flex items-center gap-2 pr-16">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-muted-foreground',
          TONE_TINT.neutral,
        )}
      >
        {mine ? 'Y' : 'L'}
      </span>
      <span className="text-[length:var(--vx-text-sm)] font-semibold">{mine ? 'You' : 'The lead'}</span>
      <Ago iso={annotation.at} now={now} className="font-mono text-xs text-muted-foreground" />
      {annotation.editedAt ? (
        <span className="text-xs text-muted-foreground" title={new Date(annotation.editedAt).toLocaleString('en-GB')}>
          · edited
        </span>
      ) : null}
    </span>
  )

  if (mode === 'edit')
    return (
      <li className={card}>
        <form
          aria-label="Edit comment"
          className="flex flex-col gap-2"
          onKeyDown={leave}
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim() !== '' && draft.trim() !== annotation.comment) save.mutate(undefined)
          }}
        >
          {who}
          <Textarea
            aria-label="Comment"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="text-[length:var(--vx-text-sm)]"
          />
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

  const body = (
    <>
      {who}
      {isGeneral ? null : (
        <span className={cn('line-clamp-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground', TONE_TINT.neutral)}>
          “{annotation.quote}”
        </span>
      )}
      <span className="text-[length:var(--vx-text-sm)] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {annotation.comment}
      </span>
      {annotation.path && !isGeneral ? (
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={annotation.path}>
          {annotation.path}
          {annotation.revision === revision ? null : <span> · revision {annotation.revision}</span>}
        </span>
      ) : (
        <span className="font-mono text-[11px] text-muted-foreground">
          {annotation.revision === revision ? 'On the whole artifact' : `revision ${annotation.revision}`}
        </span>
      )}
    </>
  )
  const text = 'flex w-full min-w-0 flex-col gap-2 text-left'

  return (
    <li className={card} aria-current={active ? 'true' : undefined}>
      {onFocus ? (
        <button
          type="button"
          className={cn(text, 'cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50')}
          onClick={() => onFocus(annotation)}
        >
          {body}
        </button>
      ) : (
        <div className={text}>{body}</div>
      )}
      {mode === 'delete' ? (
        <div className="mt-2 flex items-center gap-2 text-sm" onKeyDown={leave}>
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
        <div className="absolute top-2.5 right-2 flex">
          {mine ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ACTION}
              data-shown={active ? '' : undefined}
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
            data-shown={active ? '' : undefined}
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
  focusId,
  revision,
  heading,
  now,
  onFocus,
}: {
  id: string
  title: string
  note?: string
  items: readonly Annotation[]
  focusId: string | null
  revision: number
  /** the group's heading shows only where there is more than one group to tell apart */
  heading: boolean
  now: number
  onFocus?: (annotation: Annotation) => void
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className={cn('text-xs font-medium text-muted-foreground', !heading && 'sr-only')}>{title}</h3>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((annotation) => (
          <AnnotationItem
            key={annotation.id}
            id={id}
            annotation={annotation}
            active={focusId === annotation.id}
            revision={revision}
            now={now}
            onFocus={onFocus}
          />
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
      className="flex flex-col gap-2 bg-card px-4 py-3"
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
        className="min-h-12 bg-background text-[length:var(--vx-text-sm)] dark:bg-background"
      />
      <Failure error={write.error} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="self-end"
        disabled={comment.trim() === '' || write.isPending}
      >
        Add general comment
      </Button>
    </form>
  )
}

/** The comments column: a heading with the count, the cards in their groups scrolling on their own, the general comment at the foot. */
export function Annotations({
  detail,
  focusId,
  now,
  onFocus,
}: {
  detail: ArtifactDetail
  focusId: string | null
  now: number
  onFocus: (annotation: Annotation) => void
}) {
  const groups = groupAnnotations(detail.annotations, detail.unanchored)
  const id = detail.artifact.id
  const total = groups.general.length + groups.anchored.length + groups.unanchored.length
  const several = [groups.general, groups.anchored, groups.unanchored].filter((g) => g.length > 0).length > 1
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
        <h2 className="font-heading text-base font-semibold tracking-tight">
          Comments <span className="font-normal text-muted-foreground tabular-nums">{total}</span>
        </h2>
        <p className="text-xs text-muted-foreground">Select text in the document to comment on it.</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 pb-4 lg:overflow-y-auto">
        {total === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg bg-background px-4 py-8 text-center text-sm text-muted-foreground">
            <ChatCircleTextIcon aria-hidden="true" className="size-6" />
            <p>No comments yet.</p>
          </div>
        ) : null}
        <Group
          id={id}
          title="General"
          items={groups.general}
          focusId={focusId}
          revision={detail.revision}
          heading={several}
          now={now}
        />
        <Group
          id={id}
          title="On the text"
          items={groups.anchored}
          focusId={focusId}
          revision={detail.revision}
          heading={several}
          now={now}
          onFocus={onFocus}
        />
        <Group
          id={id}
          title="Unanchored"
          note="Their text is no longer in this revision."
          items={groups.unanchored}
          focusId={focusId}
          revision={detail.revision}
          heading={several}
          now={now}
        />
      </div>
      <GeneralComment detail={detail} />
    </div>
  )
}

const VERDICT_TONE: Record<keyof typeof VERDICT_WORDS, Tone> = {
  looks_good: 'good',
  with_notes: 'accent',
  changes: 'warn',
  no_longer_applies: 'neutral',
}

/**
 * The owner's verdict on the revision shown, in the page header: the four words and an optional note behind one button;
 * once given, the verdict as a Lozenge with its note and time behind it.
 */
export function VerdictControl({ detail, now }: { detail: ArtifactDetail; now: number }) {
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
      <Popover>
        <PopoverTrigger
          aria-label="Your verdict"
          className="inline-flex cursor-pointer items-center gap-2 rounded-md text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Lozenge tone={VERDICT_TONE[given.verdict]}>{VERDICT_WORDS[given.verdict]}</Lozenge>
          <Ago iso={given.at} now={now} className="font-mono" />
        </PopoverTrigger>
        <PopoverContent align="end" className="flex flex-col gap-1">
          <p className="font-heading font-semibold">Your verdict</p>
          <p>{VERDICT_WORDS[given.verdict]}</p>
          <p className="text-muted-foreground">{given.note ?? 'No note.'}</p>
        </PopoverContent>
      </Popover>
    )
  }
  const latest = detail.artifact.revisions.at(-1)?.n
  if (latest !== undefined && detail.revision !== latest) {
    return <span className="text-xs text-muted-foreground">A verdict is given on the latest revision ({latest}).</span>
  }
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" size="sm" />}>Give your verdict</PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-2">
        <div role="group" aria-label="Verdict" className="grid grid-cols-2 gap-2">
          {(Object.keys(VERDICT_WORDS) as Array<keyof typeof VERDICT_WORDS>).map((verdict) => (
            <Button
              key={verdict}
              type="button"
              size="sm"
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
          className="min-h-16 text-[length:var(--vx-text-sm)]"
        />
        <Failure error={write.error} />
        <Button
          type="button"
          size="sm"
          disabled={choice === null || write.isPending}
          onClick={() => choice && write.mutate(choice)}
        >
          Send verdict
        </Button>
      </PopoverContent>
    </Popover>
  )
}
