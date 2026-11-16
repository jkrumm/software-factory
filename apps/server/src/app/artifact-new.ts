import { readSubmission } from '../domains/checkpoints/artifact.ts'
import type { ArtifactRecord, CheckpointStore, RevisionRecord } from '../domains/checkpoints/ports.ts'
import { projectOf, repoNameOf, repoTextOf } from '../domains/planning/sync.ts'
import type { ArtifactId } from '../domains/checkpoints/artifact.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointError, digest, issueOf } from './checkpoints.ts'
import type { NewIssueDeps } from './issue-new.ts'
import type { PlanningStores } from './planning-deps.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/** What `artifact new` and `artifact link` need: the filing's dependencies (the repo's trust boundary, the blob store, the planning stores). */
export type StandaloneArtifactDeps = Pick<NewIssueDeps, 'locate' | 'blobs' | 'clock' | 'ids'> & {
  uow: UnitOfWork<PlanningStores & { checkpoints: CheckpointStore }>
}

export type StandaloneArtifactError =
  /** the repo is not a directory inside the allowed roots (`realpath` on both sides): nothing is stored */
  { kind: 'repo_outside_roots'; detail: string } | CheckpointError

export interface StandaloneArtifact {
  /** `replayed`: the key was filed before, or the Issue was linked already */
  result: 'applied' | 'replayed'
  artifact: ArtifactRecord
  revisions: RevisionRecord[]
  links: IssueId[]
}

const detailOf = async (
  checkpoints: CheckpointStore,
  id: ArtifactId,
  result: StandaloneArtifact['result'],
): Promise<StandaloneArtifact> => {
  const artifact = await checkpoints.artifact(id)
  if (!artifact) throw new Error(`artifact ${id} vanished inside its own transaction`)
  const links = (await checkpoints.artifactLinks([id])).get(id) ?? []
  return { result, artifact, revisions: await checkpoints.revisions(id), links }
}

/**
 * `factory artifact new`: a Report no Issue owns, for the owner's comments, stored under the project its repo resolves to
 * (as `issue new` does) and linked to the Issues it concerns. It never waits and pages no one. The same `key` again
 * files nothing; without a key, the same repo, title and content are the same Report.
 */
export async function newStandaloneArtifact(
  deps: StandaloneArtifactDeps,
  input: { repo: string; raw: unknown; issues: readonly IssueId[]; key?: string | undefined },
): Promise<Result<StandaloneArtifact, StandaloneArtifactError | PortError>> {
  const raw = typeof input.raw === 'object' && input.raw !== null ? input.raw : {}
  const read = readSubmission({ ...raw, kind: 'report' })
  if (!read.ok) return read
  const submission = read.value
  if (input.repo.trim() === '') {
    return err({ kind: 'missing_field', fields: ['repo'], detail: 'a standalone artifact needs: repo' })
  }
  const located = await deps.locate(input.repo)
  if (!located.ok) {
    return located.error.kind === 'refused'
      ? err({ kind: 'repo_outside_roots', detail: located.error.detail })
      : located
  }
  const blob = await deps.blobs.put(submission.content)
  if (!blob.ok) return blob
  const submitKey = key(
    'artifact-new',
    input.key ?? digest(`${located.value}\n${submission.title}\n${blob.value.sha256}`),
  )
  return deps.uow.run<StandaloneArtifact, StandaloneArtifactError>(async (stores) => {
    const { checkpoints } = stores
    const existing = await checkpoints.artifactByKey(submitKey)
    if (existing) return ok(await detailOf(checkpoints, existing.id, 'replayed'))
    for (const issueId of input.issues) {
      if (!(await issueOf(stores.work, issueId))) return err({ kind: 'unknown_issue', issueId })
    }
    const project = projectOf(await stores.planning.projects(), located.value)
    const id = deps.ids.next('artifact')
    const at = deps.clock.now()
    const stored = await checkpoints.insertArtifact({
      id,
      key: submitKey,
      issueId: null,
      repo: project ? repoTextOf(project) : repoNameOf(located.value),
      kind: 'report',
      title: submission.title,
      format: submission.format,
      author: 'lead',
      createdAt: at,
    })
    if (!stored) return err({ kind: 'invalid', detail: `the key ${submitKey} was filed by a concurrent request` })
    await checkpoints.insertRevision({
      artifactId: id,
      n: 1,
      key: key('revision', id, 1),
      blob: blob.value.path,
      sha256: blob.value.sha256,
      bytes: blob.value.bytes,
      note: null,
      createdAt: at,
    })
    for (const issueId of input.issues) await checkpoints.linkArtifact(id, issueId, at)
    return ok(await detailOf(checkpoints, id, 'applied'))
  })
}

/** `factory artifact link`: the artifact also concerns this Issue. Linking twice is a replay. */
export function linkArtifactToIssue(
  deps: Pick<StandaloneArtifactDeps, 'uow' | 'clock'>,
  input: { artifactId: ArtifactId; issueId: IssueId },
): Promise<Result<StandaloneArtifact, StandaloneArtifactError | PortError>> {
  return deps.uow.run<StandaloneArtifact, StandaloneArtifactError>(async ({ work, checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err({ kind: 'not_found', what: 'artifact', id: input.artifactId })
    if (!(await issueOf(work, input.issueId))) return err({ kind: 'unknown_issue', issueId: input.issueId })
    const linked =
      artifact.issueId === input.issueId
        ? false
        : await checkpoints.linkArtifact(artifact.id, input.issueId, deps.clock.now())
    return ok(await detailOf(checkpoints, artifact.id, linked ? 'applied' : 'replayed'))
  })
}

/**
 * `factory artifact retire|restore`: a Report leaves the list (a copy a standalone Report superseded, a page of a cancelled
 * Issue) or comes back; its address, revisions and annotations work either way. Only a Report: a Concept or Spec is an
 * Issue's wait, and hiding it would hide the wait. Doing it twice is a replay.
 */
export function setArtifactRetired(
  deps: Pick<StandaloneArtifactDeps, 'uow' | 'clock'>,
  input: { artifactId: ArtifactId; retired: boolean },
): Promise<Result<StandaloneArtifact, StandaloneArtifactError | PortError>> {
  return deps.uow.run<StandaloneArtifact, StandaloneArtifactError>(async ({ checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err({ kind: 'not_found', what: 'artifact', id: input.artifactId })
    if (artifact.kind !== 'report') {
      return err({
        kind: 'machine_refused',
        detail: `${artifact.id} is a ${artifact.kind}: only a Report can be retired`,
      })
    }
    const changed = input.retired
      ? await checkpoints.retireArtifact(artifact.id, deps.clock.now())
      : await checkpoints.restoreArtifact(artifact.id)
    return ok(await detailOf(checkpoints, artifact.id, changed ? 'applied' : 'replayed'))
  })
}
