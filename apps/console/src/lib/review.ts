import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { ArtifactDetail } from '@software-factory/contract'
import { deleteAnnotation, patchAnnotation, postAnnotation } from '@/lib/api'
import { GLOBAL_PATH } from '@/lib/artifact'

/**
 * The review's writes as the owner sees them: a comment, an edit or a delete shows at once and is sent in the background.
 * Each write is kept here (its text with it) until the server has acknowledged it and the artifact has been read again, so
 * a slow or failed request never loses what was typed: it stays on screen as `failed` with a retry.
 */

type Annotation = ArtifactDetail['annotations'][number]

export interface NewComment {
  revision: number
  quote: string
  path?: string
  comment: string
}

type Write =
  | { kind: 'create'; body: NewComment }
  | { kind: 'edit'; annotationId: string; comment: string }
  | { kind: 'delete'; annotationId: string }

/** `saved`: the server has it and the page is reading it back; it counts as done. */
export type Delivery = Write & { key: string; state: 'sending' | 'saved' | 'failed'; error: string | null; at: string }

/** A comment as the sidebar lists it. `anchored`: its quote is in the revision shown. */
export interface ReviewItem extends Annotation {
  anchored: boolean
  /** the write that has not been acknowledged yet, when there is one (a `saved` one is done and shows as plain) */
  delivery: Delivery | null
}

const live = (d: Delivery | undefined) => d !== undefined && d.state !== 'saved'

/** The list the sidebar shows: the server's comments with every write not yet read back applied on top. */
export function reviewItems(detail: ArtifactDetail, pending: readonly Delivery[]): ReviewItem[] {
  const edits = new Map<string, Delivery>()
  const deletes = new Map<string, Delivery>()
  for (const d of pending) {
    if (d.kind === 'edit') edits.set(d.annotationId, d)
    if (d.kind === 'delete') deletes.set(d.annotationId, d)
  }
  const server: Array<{ annotation: Annotation; anchored: boolean }> = [
    ...detail.annotations.map((annotation) => ({ annotation, anchored: true })),
    ...detail.unanchored.map((annotation) => ({ annotation, anchored: false })),
  ]
  const items: ReviewItem[] = []
  for (const { annotation, anchored } of server) {
    const gone = deletes.get(annotation.id)
    // a delete that is sending or done is gone from the list; a failed one is back, with its retry
    if (gone && gone.state !== 'failed') continue
    const edit = edits.get(annotation.id)
    const delivery = gone ?? (edit && live(edit) ? edit : null)
    items.push({
      ...annotation,
      anchored,
      comment: edit ? (edit as { comment: string }).comment : annotation.comment,
      delivery,
    })
  }
  for (const d of pending) {
    if (d.kind !== 'create') continue
    const { revision, quote, path, comment } = d.body
    // a saved comment hides when the server's list already has it (the read-back can overtake the write's bookkeeping)
    if (
      d.state === 'saved' &&
      server.some(
        (s) => s.annotation.revision === revision && s.annotation.quote === quote && s.annotation.comment === comment,
      )
    )
      continue
    items.push({
      id: `pending:${d.key}`,
      revision,
      quote,
      path: path ?? null,
      comment,
      author: 'owner',
      at: d.at,
      editedAt: null,
      anchored: true,
      delivery: live(d) ? d : null,
    })
  }
  return items
}

/**
 * The quotes to paint in the document: every comment whose passage is in the text shown (an earlier revision's carried
 * comment too), a new one at once, a deleted one gone.
 */
export function highlightQuotes(items: readonly ReviewItem[]): string[] {
  return items.filter((i) => i.anchored && i.path !== GLOBAL_PATH).map((i) => i.quote)
}

export function useReview(id: string) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Delivery[]>([])
  const counter = useRef(0)
  const latest = useRef(pending)
  latest.current = pending

  const patch = (key: string, change: Partial<Pick<Delivery, 'state' | 'error'>>) =>
    setPending((all) => all.map((d) => (d.key === key ? { ...d, ...change } : d)))
  const drop = (key: string) => setPending((all) => all.filter((d) => d.key !== key))

  const send = async (write: Write & { key: string }) => {
    patch(write.key, { state: 'sending', error: null })
    try {
      if (write.kind === 'create')
        await postAnnotation(id, { ...write.body, ...(write.body.path ? { path: write.body.path } : {}) })
      else if (write.kind === 'edit') await patchAnnotation(id, write.annotationId, write.comment)
      else await deleteAnnotation(id, write.annotationId)
    } catch (error) {
      patch(write.key, { state: 'failed', error: error instanceof Error ? error.message : 'The request failed' })
      return
    }
    patch(write.key, { state: 'saved' })
    await queryClient.invalidateQueries({ queryKey: ['artifact', id] })
    drop(write.key)
  }

  const start = (write: Write) => {
    const key = `w${++counter.current}`
    // an edit or a delete of the same comment replaces the one before it that has not landed
    setPending((all) => [
      ...all.filter(
        (d) =>
          !(
            write.kind !== 'create' &&
            d.kind !== 'create' &&
            d.annotationId === write.annotationId &&
            d.state === 'failed'
          ),
      ),
      { ...write, key, state: 'sending', error: null, at: new Date().toISOString() },
    ])
    void send({ ...write, key })
  }

  return {
    pending,
    create: (body: NewComment) => start({ kind: 'create', body: { ...body, comment: body.comment.trim() } }),
    edit: (annotationId: string, comment: string) => start({ kind: 'edit', annotationId, comment: comment.trim() }),
    remove: (annotationId: string) => start({ kind: 'delete', annotationId }),
    retry: (key: string) => {
      const write = latest.current.find((d) => d.key === key)
      if (write) void send(write)
    },
    /** Lets go of a write that failed: a comment that was never sent is gone, an edit or a delete is undone. */
    dismiss: drop,
  }
}

export type Review = ReturnType<typeof useReview>
