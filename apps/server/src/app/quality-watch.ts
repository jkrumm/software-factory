import type { LeadCheckout, Proof, ProofInput, Projects } from '../domains/quality/ports.ts'
import {
  type Check,
  DEFAULT_RECHECK_MS,
  DEFAULT_RETRY_MS,
  nextCheckAt,
  outcomeOf,
  stepOf,
  type Timing,
} from '../domains/quality/watch.ts'
import type { OpenWatch } from '../domains/quality/store.ts'
import type { Issue } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import type { EffectPorts } from '../domains/work/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import type { IdSource } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import { recordIn } from './issues.ts'
import { checkoutOf, type QualityUnit } from './quality-ship.ts'

export interface OpenDeps {
  uow: QualityUnit
  clock: Clock
  projects: Projects
  checkout: LeadCheckout
}

/**
 * The `start_watch` effect's port: opens the watch the ship planned, with the window the project sets. It only writes
 * the watch; `checkWatches` runs verify when the window is over, so a long window holds no outbox pass. The effect's key
 * is the watch's, so a run again opens nothing twice.
 */
export function startWatchPort(deps: OpenDeps): EffectPorts['start_watch'] {
  return async (effect) => {
    const loaded = await deps.uow.run(async ({ work }) => {
      const history = await work.history(effect.issueId)
      return ok(history ? replay(effect.issueId, history) : null)
    })
    if (!loaded.ok) return loaded
    if (loaded.value === null) return err(portError('gone', `no Issue ${effect.issueId}`))
    // The project is the directory the lead worked in: an Issue names its repo, and the lead's package located it.
    const where = await checkoutOf(deps.checkout, loaded.value, effect.payload.attempt)
    if (!where.ok) return where
    const project = await deps.projects.checksOf(where.value.repo)
    if (!project.ok) return project
    const opened = await deps.uow.run(async ({ quality }) => {
      await quality.openWatch({
        key: effect.key,
        issueId: effect.issueId,
        attempt: effect.payload.attempt,
        watch: effect.payload.watch,
        startedAt: deps.clock.now(),
        windowMs: project.value.windowMs,
        answer: null,
      })
      return ok(undefined)
    })
    return opened
  }
}

export interface WatchDeps extends OpenDeps {
  ids: IdSource
  proof: Proof
  timing: Timing
  /** no check before this: a restart is a deploy, and a check that ran in it would read the deploy as a regression */
  settledAt: Date
  /** the server stopping: a check that is killed says nothing */
  signal: AbortSignal
  /** how long a check holds its watch; a server that dies lets it go after this */
  leaseMs?: number
}

const LEASE_MS = 15 * 60_000

/** How the watch times its checks until the project says otherwise: the first retry a minute on, a blocked checkout looked at again after five. */
export const DEFAULT_TIMING: Timing = { retryMs: DEFAULT_RETRY_MS, recheckMs: DEFAULT_RECHECK_MS }

export interface WatchPass {
  checked: number
  passed: number
  regressed: number
}

/**
 * One pass over the open watches: each whose window is over (or whose retry is due) is claimed and committed, verify
 * runs off the transaction, and its result is recorded in a new one. Green records `watch_passed`; a red is retried
 * before it is a regression, because a flaky probe or a deploy still settling must not send a lead back to work; the
 * red after the last retry records `regressed`. A checkout that is not ours to move (blocked) is neither, and is
 * looked at again later. Every answer is keyed by the watch, so a crash anywhere replays to one answer.
 */
export async function checkWatches(deps: WatchDeps): Promise<Result<WatchPass, PortError>> {
  const pass: WatchPass = { checked: 0, passed: 0, regressed: 0 }
  const now = deps.clock.now()
  if (now < deps.settledAt || deps.signal.aborted) return ok(pass)
  const open = await deps.uow.run(async ({ quality }) => ok(await quality.openWatches(now)))
  if (!open.ok) return open
  for (const watch of open.value) {
    if (nextCheckAt(watch, watch.ran, deps.timing) > now) continue
    const checked = await checkOne(deps, watch, pass)
    if (!checked.ok) return checked
  }
  return ok(pass)
}

/** Whether the Issue is still in the watch this record opened: not cancelled, not on another ship. */
const isWatching = (issue: Issue | null, watch: OpenWatch): issue is Issue =>
  (issue?.state === 'watching' && issue.watch === watch.watch) === true

async function checkOne(deps: WatchDeps, watch: OpenWatch, pass: WatchPass): Promise<Result<void, PortError>> {
  const now = deps.clock.now()
  const lease = new Date(now.getTime() + (deps.leaseMs ?? LEASE_MS))
  const release = () => deps.uow.run(async ({ quality }) => ok(await quality.releaseWatch(watch.key)))

  // Claim and commit, and read what the check needs: the Issue, and what its ship deployed.
  const claimed = await deps.uow.run(async ({ work, quality }) => {
    if (!(await quality.claimWatch(watch.key, now, lease))) return ok(null)
    const history = await work.history(watch.issueId)
    const issue = history ? replay(watch.issueId, history) : null
    // The watch is moot once its Issue has moved on (cancelled, or another ship began): there is nothing to verify.
    if (!isWatching(issue, watch)) {
      await quality.answerWatch(watch.key, 'ended', now)
      return ok(null)
    }
    return ok({ issue, ship: await quality.lastShip(watch.issueId, watch.attempt) })
  })
  if (!claimed.ok) return claimed
  if (!claimed.value) return ok(undefined)
  const { issue: watched, ship } = claimed.value
  const where = await checkoutOf(deps.checkout, watched, watch.attempt)
  if (!where.ok) return releaseThen(release, where)
  const { repo } = where.value

  const project = await deps.projects.checksOf(repo)
  if (!project.ok) return releaseThen(release, project)
  const input: ProofInput = {
    repo,
    makeVerify: project.value.makeVerify,
    probes: project.value.probes,
    ...(project.value.deployMode === 'make' && ship?.commits?.deploys !== false ? { version: versionOf(ship) } : {}),
  }
  // The checks: git, make and HTTP, with a process timeout each, never inside a transaction.
  const ran = await deps.proof.run(input, deps.signal)
  // The proof answers an error only when the server is stopping: the checks say nothing, the next server asks again.
  if (!ran.ok || deps.signal.aborted) return releaseThen(release, ok(undefined))
  const checks = ran.value

  const recorded = await deps.uow.run(async ({ work, quality }) => {
    const at = deps.clock.now()
    // A check takes minutes: a cancel may have ended the watch since.
    const history = await work.history(watch.issueId)
    const issue = history ? replay(watch.issueId, history) : null
    if (!isWatching(issue, watch)) {
      await quality.answerWatch(watch.key, 'ended', at)
      return ok('ended' as const)
    }
    const outcome = outcomeOf(checks)
    await quality.recordCheck({
      watch: watch.key,
      issueId: watch.issueId,
      attempt: watch.attempt,
      at,
      outcome,
      checks: record(checks),
    })
    const step = stepOf(watch.ran, checks)
    if (step.kind === 'again') {
      await quality.releaseWatch(watch.key)
      return ok('again' as const)
    }
    const event =
      step.kind === 'pass'
        ? ({ kind: 'watch_passed', payload: { watch: watch.watch }, actor: 'factory' } as const)
        : ({ kind: 'regressed', payload: { watch: watch.watch, detail: step.detail }, actor: 'factory' } as const)
    const written = await recordIn(work, deps, {
      issueId: watch.issueId,
      key: key(event.kind, watch.issueId, watch.watch),
      event,
    })
    // A version conflict rolls the check back: the claim lapses and the next pass checks again.
    if (!written.ok) return written
    const answered =
      written.value.result === 'refused' || written.value.result === 'ignored'
        ? 'ended'
        : step.kind === 'pass'
          ? 'passed'
          : 'regressed'
    await quality.answerWatch(watch.key, answered, at)
    return ok(answered)
  })
  if (!recorded.ok) {
    // Nothing was stored. The Issue moved under us: let the watch go, the next pass checks it again (or ends it).
    if (recorded.error.kind === 'version_conflict') return releaseThen(release, ok(undefined))
    // The database is gone: the claim lapses by itself.
    return err(portError('gone', 'the check could not be recorded'))
  }
  pass.checked++
  if (recorded.value === 'passed') pass.passed++
  if (recorded.value === 'regressed') pass.regressed++
  return ok(undefined)
}

async function releaseThen(
  release: () => Promise<Result<void, PortError>>,
  result: Result<unknown, PortError>,
): Promise<Result<void, PortError>> {
  const released = await release()
  if (!released.ok) return released
  return result.ok ? ok(undefined) : result
}

const record = (checks: readonly Check[]) =>
  checks.map(({ name, ok: passed, detail }) => ({ name, ok: passed, detail }))

/** What the deployed version must hold: the `origin/<default>` the ship found. Closed on every gap. */
function versionOf(ship: { commits: { landedAt: string | null } | null } | null): NonNullable<ProofInput['version']> {
  if (!ship?.commits)
    return { problem: 'no accepted ship of this attempt is on record to check the deployed version against' }
  if (!ship.commits.landedAt)
    return { problem: 'the ship recorded no landed commit on origin to check the deployed version against' }
  return { landedAt: ship.commits.landedAt }
}
