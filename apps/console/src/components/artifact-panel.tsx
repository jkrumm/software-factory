import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactDetail } from '@software-factory/contract'
import { Ago } from '@/components/issue/ago'
import { Lozenge } from '@/components/kit/lozenge'
import { TONE_TINT, type Tone } from '@/components/kit/tone'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { InfoHint } from '@/components/kit/info-hint'
import { postNeeded, postVerdict } from '@/lib/api'
import { POPOVER_WIDTH, popoverPosition, VERDICT_CONSEQUENCES, VERDICT_WORDS } from '@/lib/artifact'
import type { Review } from '@/lib/review'
import { cn } from '@/lib/utils'
import type { Selected } from '@/components/artifact-content'

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
  review,
  revision,
  selected,
  anchor,
  docked,
  onDone,
}: {
  review: Review
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
        if (comment.trim() === '') return
        // the comment is in the list and painted in the document at once; the write goes on in the background
        review.create({
          revision,
          quote: selected.quote,
          ...(selected.path ? { path: selected.path } : {}),
          comment,
        })
        onDone()
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
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={comment.trim() === ''}>
          Add comment
        </Button>
      </div>
    </form>
  )
}

/** What the Spec screen did with the revision shown, one quiet line; a pass says nothing. */
export function ScreenLine({ detail }: { detail: ArtifactDetail }) {
  const { screen } = detail
  if (!screen || screen.outcome === 'passed') return null
  const lead = screen.outcome === 'settled' ? 'Settled by the Spec screen' : 'The Spec screen holds it'
  return (
    <p className="basis-full text-xs text-muted-foreground">
      {lead}
      {screen.note ? `: ${screen.note}` : '.'}
    </p>
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

  const marking = useWrite(detail.artifact.id, (needed: boolean) =>
    postNeeded(detail.artifact.id, { needed, revision: detail.revision }),
  )

  if (given) {
    return (
      <div className="inline-flex flex-wrap items-center gap-3">
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
            <p className="text-xs text-muted-foreground">{VERDICT_CONSEQUENCES[given.verdict]}</p>
            <p className="text-muted-foreground">{given.note ?? 'No note.'}</p>
          </PopoverContent>
        </Popover>
        <div
          role="group"
          aria-label="Needed me"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
          <span>Needed me</span>
          {([true, false] as const).map((needed) => (
            <Button
              key={String(needed)}
              type="button"
              size="xs"
              variant={given.neededMe === needed ? 'default' : 'outline'}
              aria-pressed={given.neededMe === needed}
              disabled={marking.isPending}
              onClick={() => given.neededMe !== needed && marking.mutate(needed)}
            >
              {needed ? 'Yes' : 'No'}
            </Button>
          ))}
        </div>
        <Failure error={marking.error} what="mark" />
      </div>
    )
  }
  const latest = detail.artifact.revisions.at(-1)?.n
  if (latest !== undefined && detail.revision !== latest) {
    return <span className="text-xs text-muted-foreground">A verdict is given on the latest revision ({latest}).</span>
  }
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" size="sm" />}>Give your verdict</PopoverTrigger>
      <PopoverContent align="end" className="flex w-96 flex-col gap-3">
        <div role="group" aria-label="Verdict" className="flex flex-col gap-2.5">
          {(Object.keys(VERDICT_WORDS) as Array<keyof typeof VERDICT_WORDS>).map((verdict) => (
            <div key={verdict} className="flex flex-col gap-1">
              <Button
                type="button"
                size="sm"
                variant={choice === verdict ? 'default' : 'outline'}
                aria-pressed={choice === verdict}
                aria-describedby={`verdict-${verdict}`}
                onClick={() => setChoice(verdict)}
              >
                {VERDICT_WORDS[verdict]}
              </Button>
              <p id={`verdict-${verdict}`} className="px-1 text-xs text-muted-foreground">
                {VERDICT_CONSEQUENCES[verdict]}
              </p>
            </div>
          ))}
        </div>
        <p className="flex items-start gap-0.5 text-xs text-muted-foreground">
          <span className="pt-1">Your verdicts and comments also feed the weekly retro's taste pass.</span>
          <InfoHint word="taste pass" className="shrink-0" />
        </p>
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
