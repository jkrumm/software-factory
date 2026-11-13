import { DESK_CHECKS, DESK_RESCREENS, deskDue, nextPush } from '../../domains/checkpoints/desk.ts'
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
  /** the Errand whose command was pushed to the MacBook, if one was */
  pushed: string | null
  problems: string[]
}

type Out<T> = Promise<Result<T, PortError>>

/**
 * The desk pass: one pass over every open Errand, an Issue's and a request, when the owner is back at the desk (a Console
 * read after two hours or more away) and in any case every 6 hours. In order, so each step works on what the last left:
 *
 * 1. every `check` runs (outside any transaction): exit 1..125 closes the Errand and tells its lead it is no longer needed;
 * 2. the rest are screened again: an Errand an agent can do now, or that asks the owner to approve a pull request, is turned
 *    away exactly as the first screen does it;
 * 3. one MacBook command is pushed through `ask-human.sh push`, the oldest not pushed lately: a dialog he answers, which
 *    closes the Errand on its own. One at a time, so the dialogs do not pile up.
 */
export async function deskPass(deps: DeskDeps): Out<DeskPass> {
  const { settle } = deps
  const now = settle.clock.now()
  const state = await deps.desk.run(async ({ desk }) =>
    ok({ lastPassAt: await desk.lastPassAt(), returnedAt: await desk.returnedAt() }),
  )
  if (!state.ok) return state
  const pass: DeskPass = { ran: false, looked: 0, resolved: 0, turnedAway: 0, pushed: null, problems: [] }
  if (!deskDue({ now, ...state.value })) return ok(pass)
  await deps.desk.run(async ({ desk }) => ok(await desk.recordPass(now)))
  pass.ran = true

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

  const next = nextPush(stillOpen, settle.clock.now())
  if (next) {
    await settle.uow.run(async ({ checkpoints }) => ok(await checkpoints.recordPush(next.id, settle.clock.now())))
    const pushed = await deps.push.push(next.id)
    if (pushed.ok) pass.pushed = next.id
    else pass.problems.push(`${next.id}: push: ${pushed.error.detail}`.slice(0, 300))
  }
  return ok(pass)
}

export const deskSummary = (pass: DeskPass): string =>
  pass.ran
    ? `${pass.looked} open Errands: ${pass.resolved} closed by their check, ${pass.turnedAway} turned back by the second screen, ${pass.pushed ? `${pass.pushed} pushed` : 'none pushed'}${
        pass.problems.length ? `: ${pass.problems.slice(0, 3).join(' | ')}` : ''
      }`
    : 'not due'
