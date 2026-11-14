import type { Intake } from '../intake.ts'
import type { IntakeStore, OpenIssues, ScreenWorkflow, Screening } from '../../domains/intake/ports.ts'
import {
  checkScreen,
  decideFinal,
  FINAL_SCREEN_MS,
  isFinalScreen,
  MAX_SCREEN_ATTEMPTS,
  SCREEN_BATCH,
  screenBackoffMs,
  screenRequest,
  screenTarget,
} from '../../domains/intake/screen.ts'
import type { Clock } from '../../kernel/clock.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'
import type { SignalRow } from '../../domains/intake/ports.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface ScreenDeps {
  uow: UnitOfWork<{ intake: IntakeStore }>
  clock: Clock
  workflow: ScreenWorkflow
  openIssues: OpenIssues
  /** planning's project reader: which repos are projects (and not work repos), and their names */
  projects: {
    find(repo: string): Promise<Result<{ work: boolean } | null, PortError>>
    names(): Promise<Result<string[], PortError>>
  }
  /** intake's own use cases: they open their transactions and look at the signal's state again */
  promote: Intake['promote']
  dismiss: Intake['dismiss']
}

export interface ScreenPass {
  looked: number
  promoted: number
  dismissed: number
  /** left to the owner, with a recommendation */
  left: number
  /** the owner acted first */
  notHeld: number
  /** calls that failed or whose answer could not be acted on */
  failed: number
  /** of those, the ones whose call answered but promote or dismiss was refused */
  actFailed: number
  problems: string[]
}

type Out<T> = Promise<Result<T, PortError>>

const detailOf = (error: { kind: string } & Partial<{ detail: string }>): string =>
  `${error.kind}${error.detail ? `: ${error.detail}` : ''}`.slice(0, 300)

/** Records a screening while the signal is still held; the owner may have acted since the claim. */
async function record(deps: ScreenDeps, id: string, screening: Screening): Promise<string | null> {
  const stored = await deps.uow.run(async ({ intake }) => ok(await intake.setScreening(id, screening)))
  return stored.ok ? null : `${id}: ${stored.error.detail}`.slice(0, 300)
}

async function screenOne(deps: ScreenDeps, row: SignalRow, names: string[], pass: ScreenPass): Promise<void> {
  const signal = row.received.signal
  // A work repo's held signal (a lead's follow-up for an owner-filed Issue) is the owner's alone: no workflow reads it
  // and the last look never dismisses it.
  const home = signal.repo ? await deps.projects.find(signal.repo) : ok(null)
  if (!home.ok) {
    pass.problems.push(`${row.id}: ${home.error.detail}`.slice(0, 300))
    return
  }
  if (home.value?.work) {
    const stored = await deps.uow.run(async ({ intake }) =>
      ok(
        await intake.setScreening(row.id, {
          ...row.screening,
          note: 'a work repo: it waits for the owner',
          at: deps.clock.now(),
          retryAt: null,
        }),
      ),
    )
    if (!stored.ok) pass.problems.push(`${row.id}: ${stored.error.detail}`.slice(0, 300))
    else if (stored.value) pass.left++
    else pass.notHeld++
    return
  }
  const open = signal.repo ? await deps.openIssues.inRepo(signal.repo) : ok([])
  if (!open.ok) {
    pass.problems.push(`${row.id}: ${open.error.detail}`.slice(0, 300))
    return
  }

  const attempt = row.screening.attempts
  const final = isFinalScreen(row, deps.clock.now())
  const answered = await deps.workflow.screen(
    screenRequest(row, open.value, names, scrub, final),
    key('screen', row.id, attempt),
  )
  const fail = async (why: string): Promise<void> => {
    pass.failed++
    pass.problems.push(`${row.id}: ${why}`.slice(0, 300))
    const now = deps.clock.now()
    const problem = await record(deps, row.id, {
      ...row.screening,
      attempts: attempt + 1,
      retryAt: new Date(now.getTime() + screenBackoffMs(attempt)),
    })
    if (problem) pass.problems.push(problem)
  }
  if (!answered.ok) return fail(`${answered.error.kind}: ${answered.error.detail}`)

  const target = screenTarget(signal.repo, answered.value)
  let repoKnown = false
  if ((answered.value.verdict === 'promote' || final) && target !== null) {
    const found = await deps.projects.find(target)
    if (!found.ok) return fail(found.error.detail)
    repoKnown = found.value !== null && !found.value.work
  }
  const screened = checkScreen({ signalRepo: signal.repo, openIssues: open.value, repoKnown }, answered.value)
  if (screened.action === 'refused') return fail(screened.why)
  // the last look after 72 hours decides: the held signal leaves Needs you
  const checked = final ? decideFinal(screened, { target, repoKnown }) : screened

  if (checked.action === 'leave') {
    const stored = await deps.uow.run(async ({ intake }) =>
      ok(
        await intake.setScreening(row.id, {
          ...row.screening,
          note: checked.note,
          at: deps.clock.now(),
          retryAt: null,
        }),
      ),
    )
    if (!stored.ok) pass.problems.push(`${row.id}: ${stored.error.detail}`.slice(0, 300))
    else if (stored.value) pass.left++
    else pass.notHeld++
    return
  }

  const acted =
    checked.action === 'promote'
      ? await deps.promote(row.id, { repo: checked.repo }, 'judge', checked.steer)
      : await deps.dismiss(row.id, { reason: checked.reason }, 'judge')
  if (acted.ok) {
    if (checked.action === 'promote') pass.promoted++
    else pass.dismissed++
    return
  }
  if (acted.error.kind === 'not_held') {
    pass.notHeld++
    return
  }
  pass.actFailed++
  return fail(detailOf(acted.error))
}

/**
 * One pass of the screen loop: the Judge looks at up to ten held signals it has not screened (oldest first), one
 * `factory-screen` call each, and the answer is checked against what it was shown before the signal is promoted, dismissed or
 * left. The list is read and committed first, the call is made outside any transaction, and promote and dismiss open their
 * own and look at the state again, so a replayed pass cannot act twice (the call's key is `screen:<signal>:<attempt>`).
 * A failed call leaves the signal held and records the attempt with a backoff; the pass itself still ends ok.
 */
export async function screenPass(deps: ScreenDeps): Out<ScreenPass> {
  const pass: ScreenPass = {
    looked: 0,
    promoted: 0,
    dismissed: 0,
    left: 0,
    notHeld: 0,
    failed: 0,
    actFailed: 0,
    problems: [],
  }
  const due = await deps.uow.run(async ({ intake }) =>
    ok(await intake.screenable(deps.clock.now(), MAX_SCREEN_ATTEMPTS, SCREEN_BATCH, FINAL_SCREEN_MS)),
  )
  if (!due.ok) return due
  if (due.value.length === 0) return ok(pass)
  const names = await deps.projects.names()
  if (!names.ok) return names
  for (const row of due.value) {
    pass.looked++
    await screenOne(deps, row, names.value, pass)
  }
  return ok(pass)
}

export function screenSummary(pass: ScreenPass): string {
  if (pass.looked === 0) return 'no held signal to screen'
  const done = `looked at ${pass.looked} held; promoted ${pass.promoted}, dismissed ${pass.dismissed}, left ${pass.left}, owner first ${pass.notHeld}`
  if (pass.failed === pass.looked) {
    const what = pass.actFailed === pass.failed ? 'acting failed' : 'screen workflow unavailable'
    return `${what}: ${pass.failed} call(s) failed${pass.problems[0] ? ` (${pass.problems[0]})` : ''}`
  }
  const problems = pass.problems.length
    ? `; ${pass.problems.length} problem(s): ${pass.problems.slice(0, 3).join(' | ')}`
    : ''
  return `${done}${pass.failed ? `, failed ${pass.failed}` : ''}${problems}`
}
