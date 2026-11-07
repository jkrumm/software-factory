import { HookEventBody, type HookEventAnswer, type StopCheck } from '@software-factory/contract'
import type { SpoolLine } from '@software-factory/contract/spool'
import { parseLeadKey } from '../domains/leads/names.ts'
import { deriveSession } from '../domains/leads/session.ts'
import { decideStop, reportedSince, sendBackMessage } from '../domains/leads/stop.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { recordIn } from './issues.ts'
import { type LeadDeps, loadIssue, toPortError } from './leads.ts'

/**
 * Stores one hook event of a lead's session and reacts to it in the same transaction, so a fact and the Issue event it
 * caused are both there or both not. The key (session, event, turn) makes a replay, from the socket or the spool, one
 * event. A line of a session that is no lead's is dropped.
 *
 * Reactions: a turn that starts ends an `unreported` or `wall` stall of that attempt (`woken`), and a `limit_stop` is
 * a `wall` stall. Nothing else the hooks say moves the Issue; the session's state is derived when read.
 */
export async function recordHook(deps: LeadDeps, line: SpoolLine): Promise<Result<HookEventAnswer, PortError>> {
  // The socket checks a line with this schema; a spool line gets the same check, so a row of a kind the reads cannot parse is never stored.
  if (!HookEventBody.safeParse(line).success) return ok({ recorded: false, reacted: null })
  const lead = parseLeadKey(line.session)
  // `pane_gone` and `runner_restarted` are the factory's own findings: a session never reports them.
  if (!lead || line.kind === 'pane_gone' || line.kind === 'runner_restarted')
    return ok({ recorded: false, reacted: null })
  const at = new Date(line.at)
  if (Number.isNaN(at.getTime())) return ok({ recorded: false, reacted: null })

  // A port is never called inside a transaction: the window is read first.
  let wall = 'the account hit its window'
  if (line.kind === 'limit_stop') {
    const account = await deps.uow.run(async ({ leads }) =>
      ok((await leads.attempt(lead.issue, lead.attempt))?.account ?? null),
    )
    if (account.ok && account.value) {
      const window = await deps.windows.wall(account.value)
      if (window.ok && window.value.resetAt)
        wall = `the account's window opens again at ${window.value.resetAt.toISOString()}`
    }
  }

  const received = deps.clock.now()
  const recorded = await deps.uow.run(async ({ work, leads }) => {
    const stored = await leads.appendHook({
      issue: lead.issue,
      attempt: lead.attempt,
      session: line.session,
      fact: { key: line.key, kind: line.kind, at, payload: line.payload ?? {} },
      receivedAt: received,
    })
    if (!stored) return ok<HookEventAnswer>({ recorded: false, reacted: null })
    const loaded = await loadIssue(work, lead.issue)
    if (!loaded || loaded.issue.attempt !== lead.attempt) return ok<HookEventAnswer>({ recorded: true, reacted: null })
    const { issue, history } = loaded

    if (line.kind === 'turn_started' && issue.state === 'waiting' && issue.wait) {
      const reason = issue.wait.reason
      if (reason !== 'unreported' && reason !== 'wall') return ok<HookEventAnswer>({ recorded: true, reacted: null })
      // A line replayed from before the stall says nothing about the stall.
      const began = history.find((record) => record.version === issue.wait?.since)
      if (began && at.getTime() <= began.at.getTime()) return ok<HookEventAnswer>({ recorded: true, reacted: null })
      const result = await recordIn(work, deps, {
        issueId: lead.issue,
        key: key('woken', lead.issue, issue.wait.since),
        event: {
          kind: 'woken',
          payload: { since: issue.wait.since, detail: 'the lead started a turn' },
          actor: 'factory',
        },
      })
      return result.ok ? ok<HookEventAnswer>({ recorded: true, reacted: 'woken' }) : result
    }
    if (line.kind === 'limit_stop' && issue.state === 'working') {
      const result = await recordIn(work, deps, {
        issueId: lead.issue,
        key: key('stalled', 'wall', lead.issue, lead.attempt, line.key),
        event: { kind: 'stalled', payload: { attempt: lead.attempt, cause: 'wall', detail: wall }, actor: 'factory' },
      })
      return result.ok ? ok<HookEventAnswer>({ recorded: true, reacted: 'stalled' }) : result
    }
    return ok<HookEventAnswer>({ recorded: true, reacted: null })
  })
  return recorded.ok ? recorded : err(toPortError(recorded.error))
}

/**
 * Whether a lead's stop is turned back, asked by the Stop hook before it records anything: a stop that is sent back is
 * no end, so the turn goes on. Sent back once per turn (`sendback:<session>:<turn>`); the stop after that, which comes
 * with `stopHookActive`, stalls the Issue as `unreported` and is let through. Any session that is no working lead's has
 * nothing said to it.
 */
export async function stopCheck(
  deps: LeadDeps,
  session: string,
  input: { stopHookActive: boolean; backgroundTasks: boolean },
): Promise<Result<StopCheck, PortError>> {
  const lead = parseLeadKey(session)
  const through: StopCheck = { sendBack: false, message: null }
  if (!lead) return ok(through)
  const at = deps.clock.now()
  const checked = await deps.uow.run(async ({ work, leads }) => {
    const loaded = await loadIssue(work, lead.issue)
    if (!loaded) return ok(through)
    const { issue, history } = loaded
    const working = issue.state === 'working' && issue.attempt === lead.attempt
    if (!working || input.backgroundTasks) return ok(through)
    const row = await leads.attempt(lead.issue, lead.attempt)
    const view = deriveSession(await leads.hookFacts(session))
    const turn = view.turns
    if (!row?.startedAt || turn === 0 || !view.lastTurnAt) return ok(through)

    // The first turn is the brief's; a later one is the factory's when a note was typed after the one before began.
    const typed = await leads.typedAt(lead.issue, lead.attempt)
    const factoryTurn =
      turn === 1 ||
      typed.some((when) => (!view.previousTurnAt || when > view.previousTurnAt) && when <= (view.lastTurnAt as Date))
    const sendbackKey = key('sendback', session, turn)
    const decision = decideStop({
      working,
      backgroundTasks: input.backgroundTasks,
      factoryTurn,
      reported: reportedSince(history, lead.attempt, view.lastTurnAt),
      sentBack: await leads.sentBack(sendbackKey),
      stopHookActive: input.stopHookActive,
    })
    if (decision === 'let_through') return ok(through)
    if (decision === 'send_back') {
      await leads.recordSendBack({ key: sendbackKey, issue: lead.issue, attempt: lead.attempt, turn, at })
      return ok<StopCheck>({ sendBack: true, message: sendBackMessage(lead.issue) })
    }
    const stalled = await recordIn(work, deps, {
      issueId: lead.issue,
      key: key('unreported', lead.issue, lead.attempt, turn),
      event: {
        kind: 'stalled',
        payload: {
          attempt: lead.attempt,
          cause: 'unreported',
          detail: `the lead stopped twice in turn ${turn} with nothing reported`,
        },
        actor: 'factory',
      },
    })
    return stalled.ok ? ok(through) : stalled
  })
  return checked.ok ? checked : err(toPortError(checked.error))
}

/** Stores a batch of spool lines: the replay's sink. A line the server refuses is skipped, one that fails to store stops the batch. */
export async function replayLines(deps: LeadDeps, lines: readonly SpoolLine[]): Promise<number> {
  let stored = 0
  for (const line of lines) {
    const result = await recordHook(deps, line)
    if (!result.ok) throw new Error(`spool line ${line.key}: ${result.error.detail}`)
    if (result.value.recorded) stored++
  }
  return stored
}
