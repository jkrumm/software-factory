import {
  DESK_CHECKS,
  DESK_RESCREENS,
  deskDue,
  hasUnpushed,
  isReturn,
  PUSH_UNREACHABLE,
  pushQueue,
} from '../../domains/checkpoints/desk.ts'
import type { ErrandId } from '../../domains/checkpoints/errand.ts'
import type { CheckRun } from '../../domains/checkpoints/request.ts'
import { exitedNote } from '../../kernel/run.ts'
import { MAX_RUN_TRIES } from '../../domains/checkpoints/need.ts'
import type { DeskStore, ErrandRecord, PushPort } from '../../domains/checkpoints/ports.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { rescreenErrand, resolveErrand, retireErrand, tellCheckBroken, turnBackRan } from '../checkpoints-errands.ts'
import { runCheck } from './errands.ts'
import type { SettleDeps } from '../checkpoints-settle.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { syncPlaceErrands, syncSummary } from '../checkpoints-sync.ts'
import type { SyncPort } from '../../domains/checkpoints/ports.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

/** the composition asks it before it starts a pass, and imports no domain code */
export { hasUnpushed }

export interface DeskDeps {
  settle: SettleDeps
  desk: UnitOfWork<{ desk: DeskStore }>
  push: PushPort
  /** the owner asked for it (the Needs you button): the pass runs now, as if he had just come back */
  force?: boolean
}

export interface DeskPass {
  /** false: the pass was not due */
  ran: boolean
  /** open Errands the pass looked at */
  looked: number
  /** closed because their check exited 1..125 */
  resolved: number
  /** turned back by the second screen */
  turnedAway: number
  /** ended because their command failed twice */
  retired: number
  /** turned back because their command ran (exit 0) and their check still says the step is needed: never pushed again */
  ranBack: number
  /** he was back for this pass: every pending MacBook command was pushed, not one */
  returned: boolean
  /** the Errands whose command was pushed to the MacBook, in the order they were */
  pushed: string[]
  problems: string[]
}

type Out<T> = Promise<Result<T, PortError>>

/**
 * The desk pass: one pass over every open Errand, an Issue's and a request, when the owner is back at the desk (a Console
 * read after two hours or more away, the MacBook answering after it was unreachable, or his button) and in any case every
 * 6 hours; an Errand with a MacBook command that reached him and was never pushed makes one due too, so its dialog
 * is on his MacBook when it is raised. A return starts the pass at once (`app/visit.ts`); the loop's tick only asks whether one is due. In order, so
 * each step works on what the last left:
 *
 * 1. every `check` runs (outside any transaction): exit 1..125 closes the Errand and tells its lead it is no longer needed;
 * 2. the rest are screened again: an Errand an agent can do now, or that asks the owner to approve a pull request, is turned
 *    away exactly as the first screen does it;
 * 3. the MacBook commands are pushed through `ask-human.sh push`, each a dialog he answers, which closes the Errand on its
 *    own. Back, every pending one, oldest first, the next after the last was answered or timed out (the push waits for the
 *    click); away, the one not pushed lately, so the dialogs do not pile up. A push the MacBook did not answer ends the
 *    run: the rest would find it down too, and the next sign of it answering is his return.
 *
 * Before any of it, a MacBook known to be down is probed; the probe answering counts as his return.
 */
export async function deskPass(deps: DeskDeps): Out<DeskPass> {
  const { settle } = deps
  const now = settle.clock.now()
  const pass: DeskPass = {
    ran: false,
    looked: 0,
    resolved: 0,
    turnedAway: 0,
    retired: 0,
    ranBack: 0,
    returned: false,
    pushed: [],
    problems: [],
  }
  const down = await deps.desk.run(async ({ desk }) => ok((await desk.macbookUp()) === false))
  if (!down.ok) return down
  let macbookDown = down.value
  if (macbookDown && (await deps.push.probe())) {
    await deps.desk.run(async ({ desk }) => ok(await desk.setMacbook(true, now)))
    macbookDown = false
  }
  const state = await deps.desk.run(async ({ desk }) =>
    ok({ lastPassAt: await desk.lastPassAt(), returnedAt: await desk.returnedAt() }),
  )
  if (!state.ok) return state
  const force = deps.force === true
  const read = await settle.uow.run(async ({ checkpoints }) => ok(await checkpoints.openErrands(500)))
  if (!read.ok) return read
  // a command Errand never pushed goes at once; not to a MacBook known to be down, which the probe above asks again each tick
  const fresh = !macbookDown && hasUnpushed(read.value)
  if (!deskDue({ now, ...state.value, force, fresh })) return ok(pass)
  await deps.desk.run(async ({ desk }) => ok(await desk.recordPass(now)))
  pass.ran = true
  pass.returned = isReturn({ ...state.value, force })

  pass.looked = read.value.length
  let checks = 0
  let rescreens = 0
  const left = []
  // the errands loop's own check step, with an Issue's Errand closed through its wait
  const checked = { kept: 0, checkedOut: 0, unrunnable: 0, problems: pass.problems }
  // the checks this pass saw say "still needed" (exit 0), with what they printed
  const stillNeeded = new Map<string, CheckRun>()
  const checkDeps = {
    stillNeeded: (errand: ErrandRecord, run: CheckRun) => void stillNeeded.set(errand.id, run),
    uow: settle.uow,
    clock: settle.clock,
    checks: settle.checks,
    resolve: async (errand: { id: ErrandId }, why: string) => {
      const closed = await resolveErrand(settle, errand.id, why)
      if (!closed.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(closed.error)}`.slice(0, 300))
      return closed.ok && closed.value
    },
    broken: async (errand: ErrandRecord, line: string) => {
      const told = await tellCheckBroken(settle, errand, line)
      if (!told.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(told.error)}`.slice(0, 300))
    },
  }
  for (const errand of read.value) {
    if (errand.checkCommand !== null && checks < DESK_CHECKS) {
      checks++
      const before = checked.checkedOut
      await runCheck(checkDeps, errand, errand.checkCommand, checked)
      if (checked.checkedOut > before) {
        pass.resolved++
        continue
      }
    }
    left.push(errand)
  }

  const stillOpen = []
  for (const errand of left) {
    // its command came back unsuccessful twice: it is not offered again, and whoever raised it is told to correct it
    // its command ran and exited 0, and the check this pass just ran still says the step is needed: it is not pushed again,
    // and whoever raised it is told once with what the check printed
    const seen = stillNeeded.get(errand.id)
    if (errand.runStatus === 'done' && seen) {
      const back = await turnBackRan(settle, errand.id, exitedNote(seen.exit, seen.output))
      if (!back.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(back.error)}`.slice(0, 300))
      else if (back.value) {
        pass.ranBack++
        continue
      }
    }
    if (
      errand.runAttempts >= MAX_RUN_TRIES &&
      errand.runStatus !== null &&
      errand.runStatus !== 'running' &&
      errand.runStatus !== 'done'
    ) {
      const retired = await retireErrand(settle, errand.id)
      if (!retired.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(retired.error)}`.slice(0, 300))
      else if (retired.value) {
        pass.retired++
        continue
      }
    }
    if (errand.reachedOwnerAt !== null && rescreens < DESK_RESCREENS) {
      rescreens++
      const screened = await rescreenErrand(settle, errand.id)
      if (!screened.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(screened.error)}`.slice(0, 300))
      else if (screened.value === 'turned_away') {
        pass.turnedAway++
        continue
      }
    }
    stillOpen.push(errand)
  }

  for (const next of pushQueue(stillOpen, settle.clock.now(), pass.returned, { includePlace: force })) {
    await settle.uow.run(async ({ checkpoints }) => ok(await checkpoints.recordPush(next.id, settle.clock.now())))
    const pushed = await deps.push.push(next.id)
    if (!pushed.ok) {
      pass.problems.push(`${next.id}: push: ${pushed.error.detail}`.slice(0, 300))
      break
    }
    const up = pushed.value.exit !== PUSH_UNREACHABLE
    await deps.desk.run(async ({ desk }) => ok(await desk.setMacbook(up, null)))
    if (!up) {
      pass.problems.push(
        `${next.id}: the MacBook did not answer (exit ${PUSH_UNREACHABLE}); the push waits for its return`,
      )
      break
    }
    pass.pushed.push(next.id)
  }
  return ok(pass)
}

const deskSummary = (pass: DeskPass): string =>
  pass.ran
    ? `${pass.looked} open Errands: ${pass.resolved} closed by their check, ${pass.turnedAway} turned back by the second screen, ${pass.retired} ended after a command failed twice, ${pass.ranBack} turned back after their command ran and the check still said needed, ${pass.pushed.length > 0 ? `${pass.pushed.length} pushed${pass.returned ? ' (he was back)' : ''}` : 'none pushed'}${
        pass.problems.length ? `: ${pass.problems.slice(0, 3).join(' | ')}` : ''
      }`
    : 'not due'

/**
 * The desk pass over the open Errands, when the owner is back after two hours or more (his Console read starts it at once;
 * so does the MacBook answering after it was down, or his button) and every six hours: checks, a second screen, and the
 * MacBook commands pushed, every pending one when he is back, one per pass while he is away, and a command that reached him
 * and was never pushed makes one due (the settle loop starts it). The loop asks every 15 minutes whether one is due.
 * `force()` is the owner's button: the next pass runs as if he had just come back.
 */
export function deskLoop(
  wiring: LoopWiring,
  deps: Omit<DeskDeps, 'force'> & { sync: SyncPort },
): { spec: LoopSpec; force(): void } {
  let forced = false
  const spec = passLoop(wiring, {
    name: 'desk',
    pass: async () => {
      const force = forced
      forced = false
      // a `place` Errand that is exactly the dotfiles sync is run through the MacBook's verb on every tick, not only when the pass is due
      const synced = await syncPlaceErrands(deps.settle, deps.sync)
      if (synced.ok) wiring.said('desk sync', synced.value.problems)
      const pass = await deskPass({ settle: deps.settle, desk: deps.desk, push: deps.push, force })
      return pass.ok ? ok({ pass: pass.value, sync: synced.ok ? syncSummary(synced.value) : '' }) : pass
    },
    problems: ({ pass }) => pass.problems,
    summary: ({ pass, sync }) => (sync === '' ? deskSummary(pass) : `${deskSummary(pass)}; ${sync}`),
  })
  return {
    spec,
    force: () => {
      forced = true
    },
  }
}
