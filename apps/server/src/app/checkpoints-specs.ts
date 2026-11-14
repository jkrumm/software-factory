import { SPEC_SCREEN_PRECEDENTS, type SpecScreenPreview, type SpecScreenRequest } from '@software-factory/contract'
import type { ArtifactId } from '../domains/checkpoints/artifact.ts'
import { deepLink, reviewPage } from '../domains/checkpoints/page.ts'
import type { SpecScreenRecord, UnscreenedSpec } from '../domains/checkpoints/ports.ts'
import {
  checkSpecScreen,
  type RuleOutcome,
  screenSpecByRule,
  settledNote,
  SPEC_SCREEN_BACKOFF_MS,
  SPEC_SCREEN_MAX_TRIES,
  specScreenRequest,
  specSourceOf,
} from '../domains/checkpoints/spec-screen.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointError, type CheckpointStores, issueOf, verdictIn } from './checkpoints.ts'
import { PASS_LIMIT, type SettleDeps } from './checkpoints-settle.ts'

export interface SpecScreened {
  artifact: string
  revision: number
  /** `held`: a call failed and is tried again later; `dropped`: it was answered or changed under the call */
  outcome: 'held' | 'passed' | 'settled' | 'dropped'
}

type Step<T> = Promise<Result<T, CheckpointError | PortError>>

type Verdict =
  | { kind: 'decided'; outcome: 'passed' | 'settled'; by: 'rule' | 'judge' | 'failed'; reason: string }
  | { kind: 'failed'; why: string }

/** What the screen reads of one Spec revision, gathered in one transaction; the content is read after it, outside. */
interface Facts {
  spec: UnscreenedSpec
  issue: { id: string; repo: string; title: string; kind: string }
  precedents: SpecScreenRequest['precedents']
}

/** The Spec revision with its Issue and the owner's newest marks, while it is still the latest, unanswered and undecided. */
async function factsOf(deps: SettleDeps, id: ArtifactId, revision: number): Step<Facts | 'dropped'> {
  return deps.uow.run<Facts | 'dropped', CheckpointError>(async ({ work, checkpoints }) => {
    const spec = await checkpoints.lockSpecRevision(id, revision)
    if (!spec || spec.answered || spec.screen?.outcome) return ok('dropped')
    const issue = await issueOf(work, spec.artifact.issueId)
    if (!issue || issue.state === 'closed') return ok('dropped')
    return ok({
      spec,
      issue: { id: issue.id, repo: issue.repo, title: issue.title, kind: issue.kind },
      precedents: await checkpoints.specPrecedents(SPEC_SCREEN_PRECEDENTS),
    })
  })
}

type Look = { rule: RuleOutcome; request: null } | { rule: null; request: SpecScreenRequest }

/** The rules first; what they leave is the workflow's request. The blob is read here, outside any transaction. */
async function lookOf(deps: SettleDeps, facts: Facts): Step<Look> {
  const { spec } = facts
  const content = await deps.blobs.get(spec.revision.blob)
  if (!content.ok) return content
  const rule = screenSpecByRule({
    revision: spec.revision.n,
    earlier: spec.earlier,
    origin: spec.origin,
    content: content.value,
  })
  if (rule) return ok({ rule, request: null })
  return ok({
    rule: null,
    request: specScreenRequest({
      spec: {
        id: spec.artifact.id,
        revision: spec.revision.n,
        title: spec.artifact.title,
        format: spec.artifact.format,
        content: content.value,
        source: specSourceOf(spec.origin),
      },
      issue: facts.issue,
      precedents: facts.precedents,
    }),
  })
}

/**
 * Records what the screen came to, in a new transaction that locks the revision again: a verdict the owner gave meanwhile,
 * or a newer revision, drops it. A pass reaches Needs you and pages the owner; a settle is the factory's looks_good with
 * the reason as its note, so the lead builds on its defaults at once; a failed call waits for its retry, and after the
 * last try the Spec reaches the owner unscreened.
 */
function record(deps: SettleDeps, id: ArtifactId, revision: number, verdict: Verdict): Step<SpecScreened['outcome']> {
  return deps.uow.run<SpecScreened['outcome'], CheckpointError | PortError>(async (stores: CheckpointStores) => {
    const { work, checkpoints } = stores
    const spec = await checkpoints.lockSpecRevision(id, revision)
    if (!spec || spec.answered || spec.screen?.outcome) return ok('dropped')
    const issue = await issueOf(work, spec.artifact.issueId)
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
        reason: `the screen could not be reached after ${SPEC_SCREEN_MAX_TRIES} tries: ${verdict.why}`,
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

/** Screens one Spec revision: the facts, the rules, then `factory-spec-screen` through its port (no transaction open). */
async function screenSpec(deps: SettleDeps, id: ArtifactId, revision: number): Step<SpecScreened> {
  const facts = await factsOf(deps, id, revision)
  if (!facts.ok) return facts
  if (facts.value === 'dropped') return ok({ artifact: id, revision, outcome: 'dropped' })
  const look = await lookOf(deps, facts.value)
  let verdict: Verdict
  if (!look.ok)
    verdict = { kind: 'failed', why: `${look.error.kind}: ${'detail' in look.error ? look.error.detail : ''}` }
  else if (look.value.rule) {
    verdict = { kind: 'decided', outcome: look.value.rule.outcome, by: 'rule', reason: look.value.rule.reason }
  } else {
    const tries = facts.value.spec.screen?.tries ?? 0
    const answer = await deps.specScreen.screen(look.value.request, key('factory-spec-screen', id, revision, tries + 1))
    if (!answer.ok) verdict = { kind: 'failed', why: `${answer.error.kind}: ${answer.error.detail}` }
    else {
      const checked = checkSpecScreen(answer.value)
      if (checked.action === 'refused') verdict = { kind: 'failed', why: checked.why }
      else if (checked.action === 'pass') {
        verdict = { kind: 'decided', outcome: 'passed', by: 'judge', reason: checked.note || 'the screen passed it' }
      } else verdict = { kind: 'decided', outcome: 'settled', by: 'judge', reason: checked.reason }
    }
  }
  const done = await record(deps, id, revision, verdict)
  return done.ok ? ok({ artifact: id, revision, outcome: done.value }) : done
}

/** One pass over the Spec revisions the screen has not decided, oldest first. */
export async function screenSpecs(deps: SettleDeps, limit = PASS_LIMIT): Step<SpecScreened[]> {
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
 * `factory artifact screen <id>`: the screen's look at the latest revision, and what the next look would come to: the rule
 * that decides it, or the request the workflow would be sent with the owner's marks as they stand now. Nothing is written.
 * This is also the replay: the request can be piped to `agw factory-spec-screen` for a Spec decided long ago.
 */
export async function previewSpecScreen(deps: SettleDeps, id: ArtifactId): Step<SpecScreenPreview> {
  const read = await deps.uow.run<Facts & { screen: SpecScreenRecord | null }, CheckpointError>(
    async ({ work, checkpoints }) => {
      const artifact = await checkpoints.artifact(id)
      if (!artifact) return err({ kind: 'not_found', what: 'artifact', id })
      if (artifact.kind !== 'spec') return err({ kind: 'invalid', detail: `${id} is a ${artifact.kind}, not a Spec` })
      const latest = (await checkpoints.revisions(id)).at(-1)
      if (!latest) return err({ kind: 'invalid', detail: `${id} has no revision` })
      const spec = await checkpoints.lockSpecRevision(id, latest.n, { lock: false })
      if (!spec) return err({ kind: 'invalid', detail: `${id} has no revision ${latest.n}` })
      const issue = await issueOf(work, artifact.issueId)
      if (!issue) return err({ kind: 'unknown_issue', issueId: artifact.issueId })
      return ok({
        spec,
        screen: spec.screen,
        issue: { id: issue.id, repo: issue.repo, title: issue.title, kind: issue.kind },
        precedents: await checkpoints.specPrecedents(SPEC_SCREEN_PRECEDENTS),
      })
    },
  )
  if (!read.ok) return read
  const look = await lookOf(deps, read.value)
  if (!look.ok) return look
  return ok({
    artifact: id,
    revision: read.value.spec.revision.n,
    screen: specScreenView(read.value.screen),
    rule: look.value.rule,
    request: look.value.request,
  })
}
