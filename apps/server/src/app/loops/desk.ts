import {
  DESK_CHECKS,
  DESK_RESCREENS,
  deskDue,
  isReturn,
  PUSH_UNREACHABLE,
  pushQueue,
} from '../../domains/checkpoints/desk.ts'
import type { ErrandId } from '../../domains/checkpoints/errand.ts'
import type { DeskStore, PushPort } from '../../domains/checkpoints/ports.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { rescreenErrand, resolveErrand } from '../checkpoints-errands.ts'
import { runCheck } from './errands.ts'
import type { SettleDeps } from '../checkpoints-settle.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

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
 * 6 hours. A return starts the pass at once (`app/visit.ts`); the loop's tick only asks whether one is due. In order, so
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
    returned: false,
    pushed: [],
    problems: [],
  }
  const down = await deps.desk.run(async ({ desk }) => ok((await desk.macbookUp()) === false))
  if (!down.ok) return down
  if (down.value && (await deps.push.probe())) {
    await deps.desk.run(async ({ desk }) => ok(await desk.setMacbook(true, now)))
  }
  const state = await deps.desk.run(async ({ desk }) =>
    ok({ lastPassAt: await desk.lastPassAt(), returnedAt: await desk.returnedAt() }),
  )
  if (!state.ok) return state
  const force = deps.force === true
  if (!deskDue({ now, ...state.value, force })) return ok(pass)
  await deps.desk.run(async ({ desk }) => ok(await desk.recordPass(now)))
  pass.ran = true
  pass.returned = isReturn({ ...state.value, force })

  const read = await settle.uow.run(async ({ checkpoints }) => ok(await checkpoints.openErrands(500)))
  if (!read.ok) return read
  pass.looked = read.value.length
  let checks = 0
  let rescreens = 0
  const left = []
  // the errands loop's own check step, with an Issue's Errand closed through its wait
  const checked = { kept: 0, checkedOut: 0, unrunnable: 0, problems: pass.problems }
  const checkDeps = {
    uow: settle.uow,
    clock: settle.clock,
    checks: settle.checks,
    resolve: async (errand: { id: ErrandId }, why: string) => {
      const closed = await resolveErrand(settle, errand.id, why)
      if (!closed.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(closed.error)}`.slice(0, 300))
      return closed.ok && closed.value
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

  for (const next of pushQueue(stillOpen, settle.clock.now(), pass.returned)) {
    await settle.uow.run(async ({ checkpoints }) => ok(await checkpoints.recordPush(next.id, settle.clock.now())))
    const pushed = await deps.push.push(next.id)
    if (!pushed.ok) {
      pass.problems.push(`${next.id}: push: ${pushed.error.detail}`.slice(0, 300))
      break
    }
    pass.pushed.push(next.id)
    const up = pushed.value.exit !== PUSH_UNREACHABLE
    await deps.desk.run(async ({ desk }) => ok(await desk.setMacbook(up, null)))
    if (!up) break
  }
  return ok(pass)
}

export const deskSummary = (pass: DeskPass): string =>
  pass.ran
    ? `${pass.looked} open Errands: ${pass.resolved} closed by their check, ${pass.turnedAway} turned back by the second screen, ${pass.pushed.length > 0 ? `${pass.pushed.length} pushed${pass.returned ? ' (he was back)' : ''}` : 'none pushed'}${
        pass.problems.length ? `: ${pass.problems.slice(0, 3).join(' | ')}` : ''
      }`
    : 'not due'
