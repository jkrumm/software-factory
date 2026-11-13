import { ChatCircleTextIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { ArtifactDetail } from '@software-factory/contract'
import { Ago } from '@/components/issue/ago'
import { Fold } from '@/components/kit/fold'
import { Lozenge } from '@/components/kit/lozenge'
import { TONE_TINT } from '@/components/kit/tone'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DISPOSITION_TONE,
  DISPOSITION_WORDS,
  displayPath,
  firstH1,
  GLOBAL_PATH,
  normalizeQuote,
  splitByRevision,
} from '@/lib/artifact'
import type { Review, ReviewItem } from '@/lib/review'
import { cn } from '@/lib/utils'

/** The comment the owner is on: which card is open and which passage to bring into view (`tick` repeats a click). */
export interface Focus {
  id: string
  quote: string
  tick: number
  /** the passage is scrolled to (a click on the card); a click on the passage itself is already there */
  scroll: boolean
  /** the card opens for editing (a click on the passage, the owner's own comment) */
  edit: boolean
}

const ACTION =
  'size-6 text-muted-foreground opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 data-[shown]:opacity-100'

/** A write that has not landed: on its way, or failed with the words and a way to try again or let go. */
function Delivery({ item, review }: { item: ReviewItem; review: Review }) {
  const { delivery } = item
  if (!delivery) return null
  if (delivery.state === 'sending')
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {delivery.kind === 'delete' ? 'Deleting…' : 'Sending…'}
      </p>
    )
  const failed = { create: 'send', edit: 'save', delete: 'delete' }[delivery.kind]
  const letGo = { create: 'Discard', edit: 'Undo', delete: 'Keep' }[delivery.kind]
  return (
    <div role="alert" className="flex flex-col gap-2 text-sm">
      <p className="text-destructive">
        Could not {failed}: {delivery.error}
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => review.retry(delivery.key)}>
          Retry
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => review.dismiss(delivery.key)}>
          {letGo}
        </Button>
      </div>
    </div>
  )
}

/**
 * One comment as a card: who and when, the passage it quotes, the comment, where in the document. The card is a button
 * that brings its passage into view and paints it; edit (the owner's own) and delete (any) are its siblings, shown on
 * the open card, on hover and on focus, and work in place. A write that has not landed says so on the card.
 */
function AnnotationItem({
  item,
  active,
  focus,
  review,
  now,
  names,
  mark,
  onFocus,
}: {
  item: ReviewItem
  active: boolean
  focus: Focus | null
  review: Review
  now: number
  /** the document's own names, left off the front of the heading path */
  names: readonly string[]
  /** what became of a comment from an earlier revision */
  mark?: 'carried' | 'resolved by revision'
  onFocus?: (item: ReviewItem) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [draft, setDraft] = useState(item.comment)
  const card = useRef<HTMLLIElement>(null)
  const isGeneral = item.path === GLOBAL_PATH
  const mine = item.author === 'owner'
  // a comment that is on its way (or never arrived) has no server id to edit or delete yet
  const stored = !item.id.startsWith('pending:')
  const editable = mine && stored && item.delivery?.state !== 'failed'
  const path = item.path && !isGeneral ? displayPath(item.path, names) : ''

  // A click on the passage in the document opens its card here: in view, and for the owner's own comment, in edit mode.
  const tick = active ? focus?.tick : undefined
  useEffect(() => {
    if (tick === undefined || !focus) return
    card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (focus.edit && editable) {
      setDraft(item.comment)
      setMode('edit')
    }
    // only a new click on this card's passage reopens it: the comment's own changes must not
  }, [tick])

  const leave = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    setMode('view')
  }
  const surface = cn(
    'group/item relative rounded-lg bg-background p-3 transition-shadow',
    active && 'bg-muted shadow-sm',
    item.delivery?.state === 'sending' && 'opacity-70',
  )

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
      <Ago iso={item.at} now={now} className="font-mono text-xs whitespace-nowrap text-muted-foreground" />
      {item.editedAt ? (
        <span
          className="text-xs whitespace-nowrap text-muted-foreground"
          title={new Date(item.editedAt).toLocaleString('en-GB')}
        >
          · edited
        </span>
      ) : null}
    </span>
  )

  if (mode === 'edit')
    return (
      <li ref={card} className={surface} data-annotation={item.id}>
        <form
          aria-label="Edit comment"
          className="flex flex-col gap-2"
          onKeyDown={leave}
          onSubmit={(event) => {
            event.preventDefault()
            const next = draft.trim()
            if (next === '' || next === item.comment) return
            setMode('view')
            review.edit(item.id, next)
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={draft.trim() === '' || draft.trim() === item.comment}>
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
          “{item.quote}”
        </span>
      )}
      <span className="text-[length:var(--vx-text-sm)] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {item.comment}
      </span>
      {item.disposition ? (
        <span className="flex flex-col gap-1 border-l-2 border-border pl-2" data-testid="disposition">
          <span className="flex items-center gap-2">
            <Lozenge tone={DISPOSITION_TONE[item.disposition.disposition]}>
              {DISPOSITION_WORDS[item.disposition.disposition]}
            </Lozenge>
            <Ago iso={item.disposition.at} now={now} className="font-mono text-xs text-muted-foreground" />
          </span>
          {item.disposition.note ? (
            <span className="text-[length:var(--vx-text-sm)] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {item.disposition.note}
            </span>
          ) : null}
        </span>
      ) : null}
      {mark || path || isGeneral ? (
        <span className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {mark ? <span className="shrink-0 rounded-sm px-1.5 py-0.5 font-sans text-xs">{mark}</span> : null}
          <span className="truncate" title={path || undefined}>
            {isGeneral ? 'On the whole artifact' : path}
          </span>
        </span>
      ) : null}
    </>
  )
  const text = 'flex w-full min-w-0 flex-col gap-2 text-left'
  const clickable = onFocus && item.anchored && !isGeneral

  return (
    <li ref={card} className={surface} aria-current={active ? 'true' : undefined} data-annotation={item.id}>
      {clickable ? (
        <button
          type="button"
          className={cn(text, 'cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50')}
          onClick={() => onFocus(item)}
        >
          {body}
        </button>
      ) : (
        <div className={text}>{body}</div>
      )}
      {item.delivery ? (
        <div className="mt-2">
          <Delivery item={item} review={review} />
        </div>
      ) : null}
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
            onClick={() => {
              setMode('view')
              review.remove(item.id)
            }}
          >
            Delete
          </Button>
        </div>
      ) : stored && !item.delivery ? (
        <div className="absolute top-2.5 right-2 flex">
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ACTION}
              data-shown={active ? '' : undefined}
              aria-label="Edit comment"
              onClick={() => {
                setDraft(item.comment)
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
      ) : null}
    </li>
  )
}

function Group({
  title,
  note,
  items,
  heading,
  focus,
  review,
  now,
  names,
  marks,
  onFocus,
}: {
  title: string
  note?: string
  items: readonly ReviewItem[]
  /** the group's heading shows only where there is more than one group to tell apart */
  heading: boolean
  focus: Focus | null
  review: Review
  now: number
  names: readonly string[]
  marks?: boolean
  onFocus?: (item: ReviewItem) => void
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className={cn('text-xs font-medium text-muted-foreground', !heading && 'sr-only')}>{title}</h3>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <AnnotationItem
            key={item.id}
            item={item}
            active={focus?.id === item.id}
            focus={focus}
            review={review}
            now={now}
            names={names}
            mark={marks ? (item.anchored || item.path === GLOBAL_PATH ? 'carried' : 'resolved by revision') : undefined}
            onFocus={onFocus}
          />
        ))}
      </ul>
    </section>
  )
}

/** A comment on the artifact as a whole: the API wants a quote, so it hangs on the title with the path `global`. */
function GeneralComment({ detail, review }: { detail: ArtifactDetail; review: Review }) {
  const [comment, setComment] = useState('')
  return (
    <form
      aria-label="General comment"
      className="flex flex-col gap-2 bg-card px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (comment.trim() === '') return
        review.create({
          revision: detail.revision,
          quote: normalizeQuote(detail.artifact.title),
          path: GLOBAL_PATH,
          comment,
        })
        setComment('')
      }}
    >
      <Textarea
        aria-label="General comment"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="A comment on the whole artifact"
        className="min-h-12 bg-background text-[length:var(--vx-text-sm)] dark:bg-background"
      />
      <Button type="submit" variant="outline" size="sm" className="self-end" disabled={comment.trim() === ''}>
        Add general comment
      </Button>
    </form>
  )
}

/**
 * The comments column: the revision shown's comments in their groups, scrolling on their own, the comments of other
 * revisions folded away below (each says whether its passage is still in the text), the general comment at the foot.
 */
export function Annotations({
  detail,
  items,
  review,
  focus,
  now,
  onFocus,
}: {
  detail: ArtifactDetail
  items: readonly ReviewItem[]
  review: Review
  focus: Focus | null
  now: number
  onFocus: (item: ReviewItem) => void
}) {
  const { current, previous, later } = splitByRevision(items, detail.revision)
  const general = current.filter((i) => i.path === GLOBAL_PATH)
  const onText = current.filter((i) => i.path !== GLOBAL_PATH)
  const several = general.length > 0 && onText.length > 0
  const names = [
    detail.artifact.title,
    ...(detail.artifact.format === 'markdown' ? [firstH1(detail.content) ?? ''] : []),
  ]
  const shared = { focus, review, now, names }
  const [opened, setOpened] = useState({ previous: false, later: false })
  // a click on the passage of a carried comment opens its card, so the fold it is in opens with it
  const focusedIn =
    focus === null
      ? null
      : previous.some((i) => i.id === focus.id)
        ? 'previous'
        : later.some((i) => i.id === focus.id)
          ? 'later'
          : null
  useEffect(() => {
    if (focusedIn) setOpened((was) => ({ ...was, [focusedIn]: true }))
  }, [focusedIn, focus?.tick])
  const folded = (which: 'previous' | 'later', title: string, list: readonly ReviewItem[]) =>
    list.length === 0 ? null : (
      <Fold
        key={which}
        title={title}
        count={list.length}
        open={opened[which]}
        onOpenChange={(open) => setOpened((was) => ({ ...was, [which]: open }))}
      >
        <Group title={title} items={list} heading={false} marks onFocus={onFocus} {...shared} />
      </Fold>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
        <h2 className="font-heading text-base font-semibold tracking-tight">
          Comments <span className="font-normal text-muted-foreground tabular-nums">{current.length}</span>
        </h2>
        <p className="text-xs text-muted-foreground">Select text in the document to comment on it.</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 pb-4 lg:overflow-y-auto">
        {current.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg bg-background px-4 py-8 text-center text-sm text-muted-foreground">
            <ChatCircleTextIcon aria-hidden="true" className="size-6" />
            <p>No comments yet.</p>
          </div>
        ) : null}
        <Group title="General" items={general} heading={several} {...shared} />
        <Group title="On the text" items={onText} heading={several} onFocus={onFocus} {...shared} />
        {folded('previous', 'Previous revision', previous)}
        {folded('later', 'Later revision', later)}
      </div>
      <GeneralComment detail={detail} review={review} />
    </div>
  )
}
