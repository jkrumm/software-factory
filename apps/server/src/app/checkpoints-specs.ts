import type { SpecScreenPreview } from '@software-factory/contract'
import type { ArtifactId } from '../domains/checkpoints/artifact.ts'
import { deepLink, reviewPage } from '../domains/checkpoints/page.ts'
import type { SpecScreenRecord, UnscreenedSpec } from '../domains/checkpoints/ports.ts'
import {
  type RuleOutcome,
  screenSpecByRule,
  settledNote,
  SPEC_SCREEN_BACKOFF_MS,
  SPEC_SCREEN_MAX_TRIES,
  specSourceOf,
} from '../domains/checkpoints/spec-screen.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointError, type CheckpointStores, issueOf, verdictIn } from './checkpoints.ts'
import { PASS_LIMIT, type CheckpointLoopDeps } from './checkpoints-loop.ts'

export interface SpecScreened {
  artifact: string
  revision: number
  /** `held`: a call failed and is tried again later; `dropped`: it was answered or changed under the call */
  outcome: 'held' | 'passed' | 'settled' | 'dropped'
}

type Step<T> = Promise<Result<T, CheckpointError | PortError>>

type Verdict =
  | { kind: 'decided'; outcome: 'passed' | 'settled'; by: 'rule' | 'failed'; reason: string }
  | { kind: 'failed'; why: string }

/** The Spec revision, while it is still the latest, unanswered and undecided, and its Issue is open. */
async function specOf(deps: CheckpointLoopDeps, id: ArtifactId, revision: number): Step<UnscreenedSpec | 'dropped'> {
  return deps.uow.run<UnscreenedSpec | 'dropped', CheckpointError>(async ({ work, checkpoints }) => {
    const spec = await checkpoints.lockSpecRevision(id, revision)
    if (!spec || spec.answered || spec.screen?.outcome) return ok('dropped')
    const issue = spec.artifact.issueId ? await issueOf(work, spec.artifact.issueId) : null
    if (!issue || issue.state === 'closed') return ok('dropped')
    return ok(spec)
  })
}

/** The rules' look at a revision. The blob is read here, outside any transaction: a Replan's rule reads its block. */
async function lookOf(deps: CheckpointLoopDeps, spec: UnscreenedSpec): Step<RuleOutcome> {
  const content = await deps.blobs.get(spec.revision.blob)
  if (!content.ok) return content
  return ok(
    screenSpecByRule({ revision: spec.revision.n, earlier: spec.earlier, origin: spec.origin, content: content.value }),
  )
}

/**
 * Records what the screen came to, in a new transaction that locks the revision again: a verdict the owner gave meanwhile,
 * or a newer revision, drops it. A pass reaches Needs you and pages the owner; a settle is the factory's looks_good with
 * the reason as its note, so the lead builds on its defaults at once; a revision whose content cannot be read waits for
 * its retry, and after the last try reaches the owner.
 */
function record(
  deps: CheckpointLoopDeps,
  id: ArtifactId,
  revision: number,
  verdict: Verdict,
): Step<SpecScreened['outcome']> {
  return deps.uow.run<SpecScreened['outcome'], CheckpointError | PortError>(async (stores: CheckpointStores) => {
    const { work, checkpoints } = stores
    const spec = await checkpoints.lockSpecRevision(id, revision)
    if (!spec || spec.answered || spec.screen?.outcome) return ok('dropped')
    const issue = spec.artifact.issueId ? await issueOf(work, spec.artifact.issueId) : null
    if (!issue || issue.state === 'closed') return ok('dropped')
    const at = deps.clock.now()
    const tries = (spec.screen?.tries ?? 0) + (verdict.kind === 'failed' || verdict.by !== 'rule' ? 1 : 0)
    const row: SpecScreenRecord = {
      artifactId: id,
      revision,
      outcome: null,
      by: null,
      source: specSourceOf(spec.origin),
      note: null,
      tries,
      retryAt: null,
      at,
    }
    let decided: Extract<Verdict, { kind: 'decided' }>
    if (verdict.kind === 'failed') {
      if (tries < SPEC_SCREEN_MAX_TRIES) {
        await checkpoints.recordSpecScreen({
          ...row,
          note: verdict.why.slice(0, 300),
          retryAt: new Date(at.getTime() + SPEC_SCREEN_BACKOFF_MS),
        })
        return ok('held')
      }
      decided = {
        kind: 'decided',
        outcome: 'passed',
        by: 'failed',
        reason: `its content could not be read after ${SPEC_SCREEN_MAX_TRIES} tries: ${verdict.why}`,
      }
    } else decided = verdict

    const stored = await checkpoints.recordSpecScreen({
      ...row,
      outcome: decided.outcome,
      by: decided.by,
      note: decided.reason.slice(0, 300),
    })
    if (!stored) return ok('dropped')
    if (decided.outcome === 'passed') {
      await checkpoints.planPage(
        reviewPage({
          issue: { id: issue.id, repo: issue.repo },
          link: deepLink(deps.consoleUrl, id),
          artifact: id,
          revision,
          kind: 'spec',
          title: spec.artifact.title,
        }),
        at,
      )
      return ok('passed')
    }
    const given = await verdictIn(stores, deps, {
      artifactId: id,
      verdict: 'looks_good',
      note: settledNote(decided.reason),
      revision,
      by: 'factory',
    })
    return given.ok ? ok('settled') : given
  })
}

/** Screens one Spec revision by rule: no workflow reads a Spec (Issue 2732). */
async function screenSpec(deps: CheckpointLoopDeps, id: ArtifactId, revision: number): Step<SpecScreened> {
  const spec = await specOf(deps, id, revision)
  if (!spec.ok) return spec
  if (spec.value === 'dropped') return ok({ artifact: id, revision, outcome: 'dropped' })
  const look = await lookOf(deps, spec.value)
  const verdict: Verdict = look.ok
    ? { kind: 'decided', outcome: look.value.outcome, by: 'rule', reason: look.value.reason }
    : { kind: 'failed', why: `${look.error.kind}: ${'detail' in look.error ? look.error.detail : ''}` }
  const done = await record(deps, id, revision, verdict)
  return done.ok ? ok({ artifact: id, revision, outcome: done.value }) : done
}

/** One pass over the Spec revisions the screen has not decided, oldest first. */
export async function screenSpecs(deps: CheckpointLoopDeps, limit = PASS_LIMIT): Step<SpecScreened[]> {
  const held = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.unscreenedSpecs(deps.clock.now(), limit)),
  )
  if (!held.ok) return held
  const screened: SpecScreened[] = []
  for (const spec of held.value) {
    const result = await screenSpec(deps, spec.artifact, spec.revision)
    if (result.ok) screened.push(result.value)
    else console.error(`checkpoints: ${spec.artifact} could not be screened: ${JSON.stringify(result.error)}`)
  }
  return ok(screened)
}

/** The screen's look as the API shows it, on `artifact show` and in the preview. */
export const specScreenView = (screen: SpecScreenRecord | null): SpecScreenPreview['screen'] =>
  screen === null
    ? null
    : {
        revision: screen.revision,
        outcome: screen.outcome ?? 'held',
        by: screen.by,
        source: screen.source,
        note: screen.note,
        tries: screen.tries,
        at: screen.at.toISOString(),
      }

/**
 * `factory artifact screen <id>`: the screen's look at the latest revision, and the rule the next look would come to.
 * Nothing is written. `request` stays null: no workflow reads a Spec since Issue 2732.
 */
export async function previewSpecScreen(deps: CheckpointLoopDeps, id: ArtifactId): Step<SpecScreenPreview> {
  const read = await deps.uow.run<{ spec: UnscreenedSpec; screen: SpecScreenRecord | null }, CheckpointError>(
    async ({ work, checkpoints }) => {
      const artifact = await checkpoints.artifact(id)
      if (!artifact) return err({ kind: 'not_found', what: 'artifact', id })
      if (artifact.kind !== 'spec') return err({ kind: 'invalid', detail: `${id} is a ${artifact.kind}, not a Spec` })
      const latest = (await checkpoints.revisions(id)).at(-1)
      if (!latest) return err({ kind: 'invalid', detail: `${id} has no revision` })
      const spec = await checkpoints.lockSpecRevision(id, latest.n, { lock: false })
      if (!spec) return err({ kind: 'invalid', detail: `${id} has no revision ${latest.n}` })
      if (!artifact.issueId)
        return err({ kind: 'invalid', detail: `${id} is a standalone artifact: no Issue to screen it for` })
      const issue = await issueOf(work, artifact.issueId)
      if (!issue) return err({ kind: 'unknown_issue', issueId: artifact.issueId })
      return ok({ spec, screen: spec.screen })
    },
  )
  if (!read.ok) return read
  const look = await lookOf(deps, read.value.spec)
  if (!look.ok) return look
  return ok({
    artifact: id,
    revision: read.value.spec.revision.n,
    screen: specScreenView(read.value.screen),
    rule: look.value,
    request: null,
  })
}
