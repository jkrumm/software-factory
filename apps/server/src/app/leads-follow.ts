import type { LeadAttempt } from '../domains/leads/ports.ts'
import { leadKey, tabName } from '../domains/leads/names.ts'
import { deriveSession } from '../domains/leads/session.ts'
import { key } from '../kernel/keys.ts'
import { ok } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'
import { leadGone } from './leads-start.ts'

/**
 * Finds the leads whose terminal is gone: each started lead of a `working` Issue is looked up in herdr-core by its key,
 * and one with no running terminal, past the grace (from the later of its start and its last hook event), is a lead
 * gone. A core that does not answer says nothing, never "gone". The lost terminal is also a fact of the session's
 * hook stream (`pane_gone`), so its derived state reads `gone`. The same look names the tab of each lead that runs,
 * whatever its Issue waits for (`nameTab`: the app adopts a tab after the start, so the start cannot). Returns how many
 * leads were found gone.
 */
export async function followLeads(deps: LeadDeps): Promise<number> {
  const followed = await deps.uow.run(async ({ work, leads }) => {
    const out: { row: LeadAttempt; since: Date | null; title: string; working: boolean }[] = []
    for (const row of await leads.followed()) {
      const loaded = await loadIssue(work, row.issueId)
      if (!loaded || loaded.issue.state === 'closed' || loaded.issue.attempt !== row.attempt) continue
      const view = deriveSession(await leads.hookFacts(leadKey(row.issueId, row.attempt)))
      out.push({
        row,
        since: view.lastEventAt ?? row.startedAt,
        title: loaded.issue.title,
        working: loaded.issue.state === 'working',
      })
    }
    return ok(out)
  })
  if (!followed.ok) return 0
  let lost = 0
  for (const { row, since, title, working } of followed.value) {
    const name = leadKey(row.issueId, row.attempt)
    const found = await deps.terminals.find(name)
    if (!found.ok) continue
    // The label marks a tab the factory made; the name comes from the title, so a lead started before the label carried it is named too.
    for (const { live, tab, tabName: made } of found.value) {
      if (live && tab && made) await deps.terminals.nameTab({ tab, name: tabName(title) })
    }
    if (!working || found.value.some((terminal) => terminal.live)) continue
    const quiet = deps.clock.now().getTime() - Math.max(row.startedAt?.getTime() ?? 0, since?.getTime() ?? 0)
    if (quiet < deps.graceMs) continue
    const at = deps.clock.now()
    const recorded = await deps.uow.run(async ({ leads }) => {
      await leads.appendHook({
        issue: row.issueId,
        attempt: row.attempt,
        session: name,
        fact: { key: key(name, 'pane_gone'), kind: 'pane_gone', at, payload: {} },
        receivedAt: at,
      })
      return ok(undefined)
    })
    if (!recorded.ok) continue
    const gone = await leadGone(deps, row.issueId, row.attempt, 'its terminal was lost')
    if (gone.ok) lost++
  }
  return lost
}
