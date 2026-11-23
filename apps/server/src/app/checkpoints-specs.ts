import type { ArtifactId } from '../domains/checkpoints/artifact.ts'
import { deepLink, reviewPage } from '../domains/checkpoints/page.ts'
import type { SpecPathRecord, UndecidedSpec } from '../domains/checkpoints/ports.ts'
import {
  type RuleOutcome,
  routeSpecByRule,
  settledNote,
  SPEC_PATH_BACKOFF_MS,
  SPEC_PATH_MAX_TRIES,
  specSourceOf,
} from '../domains/checkpoints/spec-path.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointError, type CheckpointStores, issueOf, verdictIn } from './checkpoints.ts'
import { PASS_LIMIT, type CheckpointLoopDeps } from './checkpoints-loop.ts'
import { kindAttrs, reportLine } from '../kernel/telemetry.ts'

export interface SpecRouted {
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
async function specOf(deps: CheckpointLoopDeps, id: ArtifactId, revision: number): Step<UndecidedSpec | 'dropped'> {
  return deps.uow.run<UndecidedSpec | 'dropped', CheckpointError>(async ({ work, checkpoints }) => {
    const spec = await checkpoints.lockSpecRevision(id, revision)
    if (!spec || spec.answered || spec.recorded?.outcome) return ok('dropped')
    const issue = spec.artifact.issueId ? await issueOf(work, spec.artifact.issueId) : null
    if (!issue || issue.state === 'closed') return ok('dropped')
    return ok(spec)
  })
}

/** The rules' path for a revision. The blob is read here, outside any transaction: a Replan's rule reads its block. */
async function lookOf(deps: CheckpointLoopDeps, spec: UndecidedSpec): Step<RuleOutcome> {
  const content = await deps.blobs.get(spec.revision.blob)
  if (!content.ok) return content
  return ok(
    routeSpecByRule({ revision: spec.revision.n, earlier: spec.earlier, origin: spec.origin, content: content.value }),
  )
}

/**
 * Records where the revision went, in a new transaction that locks the revision again: a verdict the owner gave meanwhile,
 * or a newer revision, drops it. A pass reaches Needs you and pages the owner; a settle is the factory's looks_good with
 * the reason as its note, so the lead builds on its defaults at once; a revision whose content cannot be read waits for
 * its retry, and after the last try reaches the owner.
 */
function record(
  deps: CheckpointLoopDeps,
  id: ArtifactId,
  revision: number,
  verdict: Verdict,
): Step<SpecRouted['outcome']> {
  return deps.uow.run<SpecRouted['outcome'], CheckpointError | PortError>(async (stores: CheckpointStores) => {
    const { work, checkpoints } = stores
    const spec = await checkpoints.lockSpecRevision(id, revision)
    if (!spec || spec.answered || spec.recorded?.outcome) return ok('dropped')
    const issue = spec.artifact.issueId ? await issueOf(work, spec.artifact.issueId) : null
    if (!issue || issue.state === 'closed') return ok('dropped')
    const at = deps.clock.now()
    const tries = (spec.recorded?.tries ?? 0) + (verdict.kind === 'failed' || verdict.by !== 'rule' ? 1 : 0)
    const row: SpecPathRecord = {
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
      if (tries < SPEC_PATH_MAX_TRIES) {
        await checkpoints.recordSpecPath({
          ...row,
          note: verdict.why.slice(0, 300),
          retryAt: new Date(at.getTime() + SPEC_PATH_BACKOFF_MS),
        })
        return ok('held')
      }
      decided = {
        kind: 'decided',
        outcome: 'passed',
        by: 'failed',
        reason: `its content could not be read after ${SPEC_PATH_MAX_TRIES} tries: ${verdict.why}`,
      }
    } else decided = verdict

    const stored = await checkpoints.recordSpecPath({
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

/** Routes one Spec revision by rule: no workflow reads a Spec (Issue 2732). */
async function routeSpec(deps: CheckpointLoopDeps, id: ArtifactId, revision: number): Step<SpecRouted> {
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

/** One pass over the Spec revisions whose path is not decided, oldest first. */
export async function routeSpecs(deps: CheckpointLoopDeps, limit = PASS_LIMIT): Step<SpecRouted[]> {
  const held = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.undecidedSpecs(deps.clock.now(), limit)),
  )
  if (!held.ok) return held
  const routed: SpecRouted[] = []
  for (const spec of held.value) {
    const result = await routeSpec(deps, spec.artifact, spec.revision)
    if (result.ok) routed.push(result.value)
    else
      reportLine(
        'error',
        `checkpoints: ${spec.artifact} could not be routed: ${JSON.stringify(result.error)}`,
        'checkpoints.spec_route_failed',
        { ref: spec.artifact, ...kindAttrs(result.error) },
      )
  }
  return ok(routed)
}
