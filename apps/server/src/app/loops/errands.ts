import type { ErrandNeededAnswer } from '@software-factory/contract'
import type { CheckRunner, CheckpointStore, ErrandNeededPort, ErrandRecord } from '../../domains/checkpoints/ports.ts'
import {
  CHECK_FAILS_NOTED,
  CHECKS_PER_PASS,
  checkVerdict,
  closedNote,
  EVIDENCE_DAYS,
  evidenceLines,
  NEEDED_AFTER_MS,
  NEEDED_PER_PASS,
} from '../../domains/checkpoints/request.ts'
import type { Clock } from '../../kernel/clock.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface ErrandsDeps {
  uow: UnitOfWork<{ checkpoints: CheckpointStore }>
  clock: Clock
  checks: CheckRunner
  needed: ErrandNeededPort
}

export interface ErrandsPass {
  /** the open standalone Errands the pass looked at */
  looked: number
  expired: number
  /** closed because their check exited 1..125 */
  checkedOut: number
  /** closed because the still-needed workflow said so */
  judgedOut: number
  /** checks that exited 0 */
  kept: number
  /** checks that could not answer (missing command, timeout, signal) */
  unrunnable: number
  /** Errands the still-needed workflow looked at and kept, or could not answer for */
  looks: number
  problems: string[]
}

type Out<T> = Promise<Result<T, PortError>>

/** Open standalone Errands read in one pass; a queue this long is a problem of its own. */
const READ_LIMIT = 500
/** A failed look of the still-needed workflow is tried again after this long, not after a whole day. */
const NEEDED_RETRY_MS = 6 * 3_600_000

const cut = (text: string, max = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

/** Closes the Errand if it is still open; false when it was closed under the pass (the owner acted first). */
async function close(
  deps: ErrandsDeps,
  errand: ErrandRecord,
  kind: 'not_needed' | 'expired',
  by: 'check' | 'judge' | 'loop',
  why: string,
): Promise<boolean> {
  const done = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.finishErrand(errand.id, deps.clock.now(), closedNote(kind, why), { kind, by })),
  )
  return done.ok && done.value
}

async function noteCheck(deps: ErrandsDeps, errand: ErrandRecord, note: string, fails: number): Promise<void> {
  await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.recordCheck(errand.id, { at: deps.clock.now(), note, fails })),
  )
}

/** Runs the Errand's check, outside any transaction, and acts on the answer. */
async function runCheck(deps: ErrandsDeps, errand: ErrandRecord, command: string, pass: ErrandsPass): Promise<void> {
  const run = await deps.checks.run(command)
  const verdict = checkVerdict(run)
  if (verdict === 'needed') {
    pass.kept++
    await noteCheck(deps, errand, 'the check exited 0: still needed', 0)
    return
  }
  if (verdict === 'not_needed') {
    const said = `its check exited ${run.exit}${run.output === '' ? '' : `: ${cut(run.output, 600)}`}`
    if (await close(deps, errand, 'not_needed', 'check', said)) pass.checkedOut++
    return
  }
  pass.unrunnable++
  const fails = errand.checkFails + 1
  const why = run.timedOut
    ? 'timed out'
    : run.exit === null
      ? `did not start: ${cut(run.output, 160)}`
      : `exit ${run.exit}`
  await noteCheck(
    deps,
    errand,
    fails >= CHECK_FAILS_NOTED
      ? `the check could not run ${fails} times in a row (${why}); the request stays open`
      : `the check could not run (${why})`,
    fails,
  )
  if (fails === CHECK_FAILS_NOTED)
    pass.problems.push(`${errand.id}: its check could not run ${fails} times in a row (${why})`)
}

/** The still-needed look at an Errand that has no check: the request and the facts the factory holds, one call, outside any transaction. */
async function lookAt(
  deps: ErrandsDeps,
  errand: ErrandRecord,
  all: readonly ErrandRecord[],
  pass: ErrandsPass,
): Promise<void> {
  const now = deps.clock.now()
  pass.looks++
  const siblings = all.filter((other) => other.source === errand.source)
  const answered = await deps.needed.judge(
    {
      errand: {
        id: errand.id,
        source: errand.source ?? 'unknown',
        summary: scrub(errand.summary).slice(0, 200),
        detail: errand.detail === null ? null : scrub(errand.detail).slice(0, 4000),
        command: errand.command === null ? null : scrub(errand.command).slice(0, 2000),
        host: errand.host ?? 'any',
        raisedAt: errand.raisedAt.toISOString(),
        ageHours: Math.max(0, Math.floor((now.getTime() - errand.raisedAt.getTime()) / 3_600_000)),
      },
      evidence: evidenceLines(errand.id, siblings, now, (text) => cut(scrub(text), 200)),
    },
    key('factory-errand-needed', errand.id, Math.floor(now.getTime() / NEEDED_AFTER_MS)),
  )
  if (!answered.ok) {
    pass.problems.push(`${errand.id}: ${answered.error.kind}: ${answered.error.detail}`.slice(0, 300))
    // the look counts as made, early enough that the next one comes in hours, not a day
    await deps.uow.run(async ({ checkpoints }) =>
      ok(
        await checkpoints.recordNeeded(errand.id, {
          at: new Date(now.getTime() - NEEDED_AFTER_MS + NEEDED_RETRY_MS),
          note: 'the still-needed look could not be made',
        }),
      ),
    )
    return
  }
  const answer: ErrandNeededAnswer = answered.value
  if (answer.verdict === 'not_needed') {
    if (await close(deps, errand, 'not_needed', 'judge', cut(answer.reason))) pass.judgedOut++
    return
  }
  await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.recordNeeded(errand.id, { at: now, note: cut(answer.reason) })),
  )
}

/**
 * One pass of the `errands` loop over the open standalone Errands (requests no Issue raised), oldest first. A pass never
 * calls a port inside a transaction: the Errands are read and committed, each check or look runs outside one, and each
 * outcome is recorded in a transaction of its own that finds the Errand open or does nothing.
 *
 * - past its expiry: closed `expired` (an Errand with no check and no expiry of its own got 7 days at intake);
 * - with a check: the check runs (30 s, 20 a pass); exit 0 keeps it, exit 1..125 closes it `not_needed` with the output, a
 *   check that could not run (missing command, timeout, signal) leaves it open with a note;
 * - with no check, after a day and again every day: the `factory-errand-needed` workflow reads the request and what the
 *   factory holds about the source's other requests; only a `not_needed` with a reason closes it (5 looks a pass).
 *
 * Every closure shows once in the "Errands closed without you" band of the next `since` read.
 */
export async function errandsPass(deps: ErrandsDeps): Out<ErrandsPass> {
  const now = deps.clock.now()
  const read = await deps.uow.run(async ({ checkpoints }) =>
    ok(
      await checkpoints.requests({
        closedSince: new Date(now.getTime() - EVIDENCE_DAYS * 86_400_000),
        limit: READ_LIMIT,
      }),
    ),
  )
  if (!read.ok) return read
  const all = read.value
  const open = all.filter((errand) => errand.doneAt === null)
  const pass: ErrandsPass = {
    looked: open.length,
    expired: 0,
    checkedOut: 0,
    judgedOut: 0,
    kept: 0,
    unrunnable: 0,
    looks: 0,
    problems: [],
  }
  let checks = 0
  let looks = 0
  for (const errand of open) {
    if (errand.expiresAt !== null && errand.expiresAt.getTime() <= now.getTime()) {
      if (
        await close(
          deps,
          errand,
          'expired',
          'loop',
          `it ran past ${errand.expiresAt.toISOString().slice(0, 10)} unanswered`,
        )
      ) {
        pass.expired++
      }
      continue
    }
    if (errand.checkCommand !== null) {
      if (checks >= CHECKS_PER_PASS) continue
      checks++
      await runCheck(deps, errand, errand.checkCommand, pass)
      continue
    }
    const due =
      now.getTime() - errand.raisedAt.getTime() >= NEEDED_AFTER_MS &&
      (errand.neededAt === null || now.getTime() - errand.neededAt.getTime() >= NEEDED_AFTER_MS)
    if (!due || looks >= NEEDED_PER_PASS) continue
    looks++
    await lookAt(deps, errand, all, pass)
  }
  return ok(pass)
}

export const errandsSummary = (pass: ErrandsPass): string =>
  `${pass.looked} open requests: ${pass.expired} expired, ${pass.checkedOut} closed by their check, ${pass.judgedOut} by the still-needed look, ${pass.kept} kept by a check, ${pass.unrunnable} checks could not run${
    pass.problems.length ? `: ${pass.problems.slice(0, 3).join(' | ')}` : ''
  }`
