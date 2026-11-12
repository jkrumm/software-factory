import { NEW_ISSUE_SPEC_TITLE_MAX } from '@software-factory/contract'
import { deepLink, reviewPage } from '../domains/checkpoints/page.ts'
import type { BlobStore, CheckpointStore } from '../domains/checkpoints/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import type { IdSource, IssueId } from '../kernel/ids.ts'
import { type Key, key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'

/**
 * The key of the Spec a filer attached to an Issue: one per Issue, and the only way to tell it from a lead's Spec (the
 * queue holds the Issue for the first, never for the second). The SQL that reads the hold matches `filed-spec:%`.
 */
export const filedSpecKey = (issue: IssueId): Key => key('filed-spec', issue)

/** The title of a filed Spec: the one given, else the first `# ` heading, else the Issue's title. */
export function specTitleOf(input: { content: string; given: string | undefined; fallback: string }): string {
  const heading = input.content.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m)?.[1]?.trim()
  return (input.given?.trim() || heading || input.fallback).slice(0, NEW_ISSUE_SPEC_TITLE_MAX)
}

/** What `fileNewIssue` needs beside planning to store a Spec with the Issue. */
export interface FiledSpecDeps {
  blobs: BlobStore
  clock: Clock
  ids: IdSource
  /** the base of a checkpoint's deep link */
  consoleUrl: string
}

/** A Spec's content once its blob is stored: the transaction that files the Issue only writes rows. */
export interface StoredSpec {
  title: string
  blob: { path: string; sha256: string; bytes: number }
}

/** Puts the Spec's content in the blob store, outside any transaction. */
export async function storeSpecBlob(
  deps: Pick<FiledSpecDeps, 'blobs'>,
  input: { content: string; given: string | undefined; fallback: string },
): Promise<Result<StoredSpec, PortError>> {
  const blob = await deps.blobs.put(input.content)
  if (!blob.ok) return blob
  return ok({ title: specTitleOf(input), blob: blob.value })
}

/**
 * Inside the filing transaction: the Spec as an artifact of the new Issue (revision 1) and the owner's review page.
 * The Issue's own state machine is not touched: it settles and queues as any Issue, and the queue holds it until the
 * Spec has a verdict.
 */
export async function attachSpec(
  deps: FiledSpecDeps,
  checkpoints: CheckpointStore,
  issue: { id: IssueId; repo: string },
  spec: StoredSpec,
): Promise<Result<null, { kind: 'refused'; detail: string }>> {
  const id = deps.ids.next('artifact')
  const at = deps.clock.now()
  const stored = await checkpoints.insertArtifact({
    id,
    key: filedSpecKey(issue.id),
    issueId: issue.id,
    kind: 'spec',
    title: spec.title,
    format: 'markdown',
    author: 'factory',
    createdAt: at,
  })
  if (!stored) return err({ kind: 'refused', detail: `${issue.id} already has a filed Spec` })
  await checkpoints.insertRevision({
    artifactId: id,
    n: 1,
    key: key('revision', id, 1),
    blob: spec.blob.path,
    sha256: spec.blob.sha256,
    bytes: spec.blob.bytes,
    note: null,
    createdAt: at,
  })
  await checkpoints.planPage(
    reviewPage({
      issue,
      link: deepLink(deps.consoleUrl, id),
      artifact: id,
      revision: 1,
      kind: 'spec',
      title: spec.title,
    }),
    at,
  )
  return ok(null)
}
