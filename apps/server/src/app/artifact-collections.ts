import type { ArtifactId, CollectionId } from '../domains/checkpoints/artifact.ts'
import type {
  ArtifactRecord,
  CheckpointStore,
  CollectionRecord,
  CollectionStats,
} from '../domains/checkpoints/ports.ts'
import { projectOf, repoNameOf, repoTextOf } from '../domains/planning/sync.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import type { StandaloneArtifactDeps, StandaloneArtifactError } from './artifact-new.ts'
import { digest, issueOf } from './checkpoints.ts'
import type { PlanningStores } from './planning-deps.ts'

export interface Collection {
  /** `replayed`: the key was filed before, or the call changed nothing */
  result: 'applied' | 'replayed'
  collection: CollectionRecord
  stats: CollectionStats
}

type CollectionDeps = Pick<StandaloneArtifactDeps, 'uow' | 'clock' | 'ids' | 'locate'>
type CollectionResult = Result<Collection, StandaloneArtifactError | PortError>

const EMPTY: CollectionStats = { members: [], lastChange: null, openComments: 0 }

const read = async (checkpoints: CheckpointStore, collection: CollectionRecord) =>
  (await checkpoints.collectionStats([collection.id])).get(collection.id) ?? EMPTY

const finish = async (
  checkpoints: CheckpointStore,
  id: CollectionId,
  result: Collection['result'],
): Promise<Collection> => {
  const collection = await checkpoints.collection(id)
  if (!collection) throw new Error(`collection ${id} vanished inside its own transaction`)
  return { result, collection, stats: await read(checkpoints, collection) }
}

/** Every collection, pinned first, each with what its card shows. */
export function listCollections(
  deps: Pick<CollectionDeps, 'uow'>,
): Promise<Result<{ collection: CollectionRecord; stats: CollectionStats }[], PortError>> {
  return deps.uow.run(async ({ checkpoints }) => {
    const collections = await checkpoints.collections()
    const stats = await checkpoints.collectionStats(collections.map((c) => c.id))
    return ok(collections.map((collection) => ({ collection, stats: stats.get(collection.id) ?? EMPTY })))
  })
}

export function showCollection(
  deps: Pick<CollectionDeps, 'uow'>,
  id: CollectionId,
): Promise<Result<Collection, StandaloneArtifactError | PortError>> {
  return deps.uow.run<Collection, StandaloneArtifactError>(async ({ checkpoints }) => {
    const found = await checkpoints.collection(id)
    return found ? ok(await finish(checkpoints, id, 'replayed')) : err({ kind: 'not_found', what: 'collection', id })
  })
}

/** The project an artifact concerns: its own repo when standalone, else its Issue's. */
async function projectOfArtifact(
  stores: PlanningStores & { checkpoints: CheckpointStore },
  artifact: ArtifactRecord,
): Promise<string | null> {
  if (artifact.repo) return artifact.repo
  if (!artifact.issueId) return null
  return (await issueOf(stores.work, artifact.issueId))?.repo ?? null
}

/**
 * Take `ids` into the collection. An artifact in another collection is refused (it belongs to at most one: take it out
 * first), one already here is a no-op. Returns the artifacts it moved.
 */
async function take(
  checkpoints: CheckpointStore,
  collection: CollectionRecord,
  ids: readonly string[],
): Promise<Result<number, StandaloneArtifactError>> {
  let moved = 0
  for (const text of ids) {
    const artifact = await checkpoints.artifact(text as ArtifactId)
    if (!artifact) return err({ kind: 'not_found', what: 'artifact', id: text })
    if (artifact.collectionId === collection.id) continue
    if (artifact.collectionId) {
      const other = await checkpoints.collection(artifact.collectionId)
      return err({
        kind: 'machine_refused',
        detail: `${artifact.id} is in the collection "${other?.title ?? artifact.collectionId}": take it out first (artifact collection edit ${artifact.collectionId} --remove ${artifact.id})`,
      })
    }
    if (await checkpoints.setArtifactCollection(artifact.id, collection.id, null)) moved += 1
  }
  return ok(moved)
}

/**
 * `factory artifact collection new`: a named set of artifacts with one lead page. The project comes from `repo` (the
 * trust boundary applies as for `artifact new`) or from the lead page or first artifact. The same key files nothing.
 */
export async function newCollection(
  deps: CollectionDeps,
  input: {
    title: string
    repo?: string | undefined
    lead?: string | undefined
    add: readonly string[]
    pin: boolean
    key?: string | undefined
  },
): Promise<CollectionResult> {
  const title = input.title.trim()
  if (title === '') return err({ kind: 'missing_field', fields: ['title'], detail: 'a collection needs: title' })
  const members = [...new Set([...(input.lead ? [input.lead] : []), ...input.add])]
  let repo: string | null = null
  if (input.repo?.trim()) {
    const located = await deps.locate(input.repo)
    if (!located.ok) {
      return located.error.kind === 'refused'
        ? err({ kind: 'repo_outside_roots', detail: located.error.detail })
        : located
    }
    repo = located.value
  }
  const filed = key('artifact-collection', input.key ?? digest(`${repo ?? ''}\n${title}`))
  return deps.uow.run<Collection, StandaloneArtifactError>(async (stores) => {
    const { checkpoints } = stores
    const existing = await checkpoints.collectionByKey(filed)
    if (existing) return ok(await finish(checkpoints, existing.id, 'replayed'))

    let project: string | null = null
    if (repo !== null) {
      const known = projectOf(await stores.planning.projects(), repo)
      project = known ? repoTextOf(known) : repoNameOf(repo)
    } else {
      for (const id of members) {
        const artifact = await checkpoints.artifact(id as ArtifactId)
        if (!artifact) return err({ kind: 'not_found', what: 'artifact', id })
        project = await projectOfArtifact(stores, artifact)
        if (project) break
      }
    }
    if (project === null) {
      return err({
        kind: 'missing_field',
        fields: ['repo'],
        detail: 'a collection needs: repo (or a lead page or artifact that has one)',
      })
    }
    const id = deps.ids.next('collection')
    const at = deps.clock.now()
    const stored = await checkpoints.insertCollection({
      id,
      key: filed,
      title,
      repo: project,
      leadArtifactId: null,
      pinnedAt: input.pin ? at : null,
      createdAt: at,
    })
    if (!stored) return err({ kind: 'invalid', detail: `the key ${filed} was filed by a concurrent request` })
    const collection = await checkpoints.collection(id)
    if (!collection) throw new Error(`collection ${id} vanished inside its own transaction`)
    const taken = await take(checkpoints, collection, members)
    if (!taken.ok) return taken
    if (input.lead) await checkpoints.updateCollection(id, { leadArtifactId: input.lead as ArtifactId })
    return ok(await finish(checkpoints, id, 'applied'))
  })
}

/** `factory artifact collection edit`: retitle, name another lead page, take artifacts in or out. A call that changes nothing is a replay. */
export function editCollection(
  deps: Pick<CollectionDeps, 'uow'>,
  input: {
    id: CollectionId
    title?: string | undefined
    lead?: string | undefined
    add: readonly string[]
    remove: readonly string[]
  },
): Promise<CollectionResult> {
  return deps.uow.run<Collection, StandaloneArtifactError>(async ({ checkpoints }) => {
    const collection = await checkpoints.collection(input.id)
    if (!collection) return err({ kind: 'not_found', what: 'collection', id: input.id })
    const title = input.title?.trim()
    if (input.title !== undefined && title === '') {
      return err({ kind: 'invalid', detail: 'title: a collection needs a title' })
    }
    let changed = false
    const taken = await take(checkpoints, collection, [...(input.lead ? [input.lead] : []), ...input.add])
    if (!taken.ok) return taken
    changed ||= taken.value > 0
    for (const text of input.remove) {
      const artifact = await checkpoints.artifact(text as ArtifactId)
      if (!artifact) return err({ kind: 'not_found', what: 'artifact', id: text })
      if (artifact.collectionId !== collection.id) continue
      await checkpoints.setArtifactCollection(artifact.id, null, collection.id)
      changed = true
      if (collection.leadArtifactId === artifact.id) {
        await checkpoints.updateCollection(collection.id, { leadArtifactId: null })
      }
    }
    if (title !== undefined && title !== collection.title) {
      await checkpoints.updateCollection(collection.id, { title })
      changed = true
    }
    if (input.lead && input.lead !== collection.leadArtifactId) {
      await checkpoints.updateCollection(collection.id, { leadArtifactId: input.lead as ArtifactId })
      changed = true
    }
    return ok(await finish(checkpoints, collection.id, changed ? 'applied' : 'replayed'))
  })
}

/** `factory artifact collection pin|unpin`, and the owner's pin on the Artifacts screen. Doing it twice is a replay. */
export function pinCollection(
  deps: Pick<CollectionDeps, 'uow' | 'clock'>,
  input: { id: CollectionId; pinned: boolean },
): Promise<CollectionResult> {
  return deps.uow.run<Collection, StandaloneArtifactError>(async ({ checkpoints }) => {
    const collection = await checkpoints.collection(input.id)
    if (!collection) return err({ kind: 'not_found', what: 'collection', id: input.id })
    const changed = await checkpoints.setCollectionPin(collection.id, input.pinned ? deps.clock.now() : null)
    return ok(await finish(checkpoints, collection.id, changed ? 'applied' : 'replayed'))
  })
}
