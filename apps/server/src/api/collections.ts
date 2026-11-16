import { CollectionList, CollectionReply, EditCollectionBody, NewCollectionBody } from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { Collection } from '../app/artifact-collections.ts'
import type { StandaloneArtifactError } from '../app/artifact-new.ts'
import type { CollectionId } from '../domains/checkpoints/artifact.ts'
import type { CollectionRecord, CollectionStats } from '../domains/checkpoints/ports.ts'
import { idOf } from '../kernel/ids.ts'
import type { PortError, Result } from '../kernel/result.ts'
import { failed } from './checkpoints.ts'
import { errorResponses } from './errors.ts'
import type { IssueApi } from './issues.ts'
import { failure } from './written.ts'

const iso = (at: Date): string => at.toISOString()

/** A collection as the API names it: its pages oldest first, the lead page, what the card shows. */
export const collectionView = (collection: CollectionRecord, stats: CollectionStats) => ({
  id: collection.id,
  title: collection.title,
  repo: collection.repo,
  lead: collection.leadArtifactId,
  pinnedAt: collection.pinnedAt ? iso(collection.pinnedAt) : null,
  createdAt: iso(collection.createdAt),
  members: stats.members,
  memberCount: stats.members.length,
  lastChange: stats.lastChange ? iso(stats.lastChange) : null,
  openComments: stats.openComments,
})

const Params = z.object({ id: z.string() })
const unknown = (id: string): Response => Response.json(failure(`no collection ${id}`, 'not_found'), { status: 404 })

function replyOf(result: Result<Collection, StandaloneArtifactError | PortError>): Response {
  if (!result.ok) {
    return result.error.kind === 'repo_outside_roots'
      ? Response.json(failure(result.error.detail, 'repo_outside_roots'), { status: 422 })
      : failed(result.error)
  }
  const { result: outcome, collection, stats } = result.value
  return Response.json(CollectionReply.parse({ result: outcome, collection: collectionView(collection, stats) }))
}

/**
 * `factory artifact collection-*`: a named set of artifacts with one lead page. A lead may make and edit one (it groups
 * the Reports it filed); pinning is the owner's choice (`policy.ts`), made on the Artifacts screen or by `collection-pin`.
 */
export const collectionRoutes = (
  api:
    | Pick<IssueApi, 'listCollections' | 'showCollection' | 'newCollection' | 'editCollection' | 'pinCollection'>
    | undefined,
) => {
  const wired = api
  const unwired = async (): Promise<Response> =>
    Response.json(failure('the collection verbs are not wired into this server', 'unavailable'), { status: 503 })
  return new Elysia()
    .get(
      '/v1/artifact-collections',
      async () => {
        if (!wired) return unwired()
        const result = await wired.listCollections()
        if (!result.ok) return failed(result.error)
        return Response.json(
          CollectionList.parse({
            collections: result.value.map(({ collection, stats }) => collectionView(collection, stats)),
          }),
        )
      },
      {
        response: { 200: CollectionList, ...errorResponses(503) },
        detail: {
          operationId: 'artifact.collection-list',
          summary:
            'the collections of artifacts, pinned first, each with its pages, member count, last change and open comments',
        },
      },
    )
    .get(
      '/v1/artifact-collections/:id',
      async ({ params }) => {
        if (!wired) return unwired()
        const id = idOf('collection', params.id)
        if (!id) return unknown(params.id)
        return replyOf(await wired.showCollection(id))
      },
      {
        params: Params,
        response: { 200: CollectionReply, ...errorResponses(404, 503) },
        detail: { operationId: 'artifact.collection-show', summary: 'one collection: its pages, lead page and pin' },
      },
    )
    .post(
      '/v1/artifact-collections',
      async ({ body }) => {
        if (!wired) return unwired()
        return replyOf(
          await wired.newCollection({
            title: body.title ?? '',
            repo: body.repo,
            lead: body.lead,
            add: body.add ?? [],
            pin: body.pin ?? false,
            key: body.key,
          }),
        )
      },
      {
        body: NewCollectionBody,
        response: { 200: CollectionReply, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'artifact.collection-new',
          summary:
            'a named set of artifacts with one lead page (an artifact belongs to at most one collection); the same key again files nothing',
        },
      },
    )
    .post(
      '/v1/artifact-collections/:id',
      async ({ params, body }) => {
        if (!wired) return unwired()
        const id = idOf('collection', params.id)
        if (!id) return unknown(params.id)
        return replyOf(
          await wired.editCollection({
            id: id as CollectionId,
            title: body.title,
            lead: body.lead,
            add: body.add ?? [],
            remove: body.remove ?? [],
          }),
        )
      },
      {
        params: Params,
        body: EditCollectionBody,
        response: { 200: CollectionReply, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'artifact.collection-edit',
          summary: 'retitle a collection, name another lead page, take artifacts in or out; nothing is deleted',
        },
      },
    )
    .post(
      '/v1/artifact-collections/:id/pin',
      async ({ params }) => {
        if (!wired) return unwired()
        const id = idOf('collection', params.id)
        if (!id) return unknown(params.id)
        return replyOf(await wired.pinCollection({ id, pinned: true }))
      },
      {
        params: Params,
        response: { 200: CollectionReply, ...errorResponses(404, 409, 503) },
        detail: {
          operationId: 'artifact.collection-pin',
          summary: 'pin a collection: it leads the Artifacts screen as a card',
        },
      },
    )
    .post(
      '/v1/artifact-collections/:id/unpin',
      async ({ params }) => {
        if (!wired) return unwired()
        const id = idOf('collection', params.id)
        if (!id) return unknown(params.id)
        return replyOf(await wired.pinCollection({ id, pinned: false }))
      },
      {
        params: Params,
        response: { 200: CollectionReply, ...errorResponses(404, 409, 503) },
        detail: {
          operationId: 'artifact.collection-unpin',
          summary: 'unpin a collection: it joins the rest, by project',
        },
      },
    )
}
