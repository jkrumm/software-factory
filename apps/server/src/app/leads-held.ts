import { leadKey } from '../domains/leads/names.ts'
import { runsAChild } from '../domains/leads/quiesce.ts'
import { deriveSession } from '../domains/leads/session.ts'
import { ok } from '../kernel/result.ts'
import { recordHook } from './leads-hooks.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

/** A turn open and silent this long, with nothing running in its tree, on an account whose window is closed is held at the wall, not working. */
export const HELD_AFTER_MS = 2 * 60_000

/**
 * A prompt submitted to an account that is out of window is refused by Claude Code before any answer: `UserPromptSubmit`
 * fires (a turn starts), the message goes back into the input box, and neither `Stop` nor `StopFailure` follows. The hooks
 * then show a turn that never ends, so the lead counts as working and nothing wakes it (a resumed lead's first message
 * is the usual case, issue 2414). A working lead whose turn has been silent for `HELD_AFTER_MS`, with no process in its
 * tree (a tool that runs is silent to the hooks too, and a move of the lead would end it), on an account that
 * capacity reads as closed and spent (its own limit reached, not only the ceiling the factory keeps below it) is recorded as the limit stop the hook missed: the same fact, so the Issue stalls as a `wall`
 * and the steward wakes it when the window opens (or moves it to an open account). Once per turn (the key carries it);
 * a turn that starts later clears the wall as any turn does. Returns how many leads it recorded.
 */
export async function holdWalledLeads(deps: LeadDeps): Promise<number> {
  const now = deps.clock.now()
  const candidates = await deps.uow.run(async ({ work, leads }) => {
    const found: { name: string; account: string; turns: number }[] = []
    for (const row of await leads.followed()) {
      if (!row.terminal || !row.account) continue
      const loaded = await loadIssue(work, row.issueId)
      if (loaded?.issue.state !== 'working' || loaded.issue.attempt !== row.attempt) continue
      const name = leadKey(row.issueId, row.attempt)
      const view = deriveSession(await leads.hookFacts(name))
      if (view.state !== 'working' || view.walled || !view.turnStartedAt) continue
      const quietFrom = Math.max(view.lastEventAt?.getTime() ?? 0, view.turnStartedAt.getTime())
      if (now.getTime() - quietFrom < HELD_AFTER_MS) continue
      found.push({ name, account: row.account, turns: view.turns })
    }
    return ok(found)
  })
  if (!candidates.ok || candidates.value.length === 0) return 0
  let held = 0
  for (const { name, account, turns } of candidates.value) {
    // Capacity is asked outside any transaction. No `since`: the newest reading decides, so a lead is never held on a window that is open.
    const window = await deps.windows.wall(account)
    if (!window.ok || !window.value.resetAt || window.value.resetAt <= now) continue
    // Closed is not refused: the factory keeps accounts below their limit (the weekly ceiling, the 5-hour maximum), and Claude
    // Code takes prompts up to it. A quiet turn there is a lead thinking, and holding it stalled a working lead every two minutes.
    const spent = await deps.windows.spent(account)
    if (!spent.ok || !spent.value) continue
    // Fresh, and last before the record: a table that cannot be read says nothing of what runs, so nothing is held on a guess.
    const processes = await deps.processTable?.().catch(() => null)
    if (!processes || runsAChild(processes, name)) continue
    const recorded = await recordHook(deps, {
      key: `${name}:limit_stop:${turns}:held`,
      session: name,
      kind: 'limit_stop',
      at: now.toISOString(),
      payload: { error: 'rate_limit', source: 'held' },
    })
    if (recorded.ok && recorded.value.recorded) held++
  }
  return held
}
