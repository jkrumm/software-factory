import { holdsClaim } from '../domains/capacity/claims.ts'
import { leadKey } from '../domains/leads/names.ts'
import { quiesceVerdict } from '../domains/leads/quiesce.ts'
import type { LeadAttempt } from '../domains/leads/ports.ts'
import { deriveSession, type SessionView } from '../domains/leads/session.ts'
import { ok } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

interface Candidate {
  row: LeadAttempt
  name: string
  view: SessionView
  waitSince: Date | null
  version: number
}

/**
 * Quiesces the leads whose Issue waits: a lead that waits for a person, a timer or another Issue needs no process, and a
 * `claude` of 200 to 290 MiB that idles for hours is memory the host counts as used. The factory ends it
 * (`terminals.quiesce`) and keeps the attempt, its worktree and its session id; the wake that ends the wait starts the
 * session again (`noteLead`) before it delivers what woke it. The rule is `quiesceVerdict`: a quiet session, no process in
 * its tree, no slot in its worktree, a wait that gave its claim up.
 *
 * Marked before it is ended: a pass that dies between the two finds the mark with the process still running and ends it.
 * One step of the lead tick, before the outbox, so a wake never meets a lead half dormant. Returns how many were dormant.
 */
export async function quiesceLeads(deps: LeadDeps): Promise<number> {
  const ports = deps.quiesce
  if (!ports) return 0
  const now = deps.clock.now()
  const looked = await deps.uow.run(async ({ work, leads }) => {
    const waiting: Candidate[] = []
    const unfinished: Candidate[] = []
    for (const row of await leads.followed()) {
      if (!row.terminal) continue
      const loaded = await loadIssue(work, row.issueId)
      if (!loaded || loaded.issue.attempt !== row.attempt) continue
      const { state, wait } = loaded.issue
      if (state !== 'waiting' || !wait || holdsClaim(state, wait.reason)) continue
      const name = leadKey(row.issueId, row.attempt)
      const view = deriveSession(await leads.hookFacts(name))
      const candidate = {
        row,
        name,
        view,
        waitSince: loaded.history.find((record) => record.version === wait.since)?.at ?? null,
        version: loaded.issue.version,
      }
      // Dormant, yet its session never ended: the end of the last pass failed (a killed `claude` reports `SessionEnd`).
      if (row.dormantAt) {
        if (view.state !== 'gone') unfinished.push(candidate)
      } else if (
        view.state === 'idle' &&
        view.lastEventAt &&
        now.getTime() - view.lastEventAt.getTime() >= ports.afterMs
      )
        waiting.push(candidate)
    }
    return ok({ waiting, unfinished })
  })
  if (!looked.ok) return 0

  for (const { name } of looked.value.unfinished) await deps.terminals.quiesce(name)
  if (looked.value.waiting.length === 0) return 0

  // Read once for all: a table and the slots are the host's, and a pass with nothing waiting never asks.
  const slots = await ports.slotCwds().then(
    (cwds) => cwds,
    () => null,
  )
  // Slots that cannot be read say nothing of what runs: nothing is dormant on a guess.
  if (slots === null) return 0
  const [processes, slotCwds] = [await ports.processes(), slots]
  let dormant = 0
  for (const candidate of looked.value.waiting) {
    const { row, name, view, waitSince, version } = candidate
    const verdict = quiesceVerdict({
      now,
      afterMs: ports.afterMs,
      session: name,
      waitingFree: true,
      waitSince,
      view,
      processes,
      worktree: row.worktreePath,
      slotCwds,
    })
    if (!verdict.quiesce) continue
    // Marked only while the Issue still waits as it did: a wake since is not interrupted.
    const marked = await deps.uow.run(async ({ work, leads }) => {
      const loaded = await loadIssue(work, row.issueId)
      if (!loaded || loaded.issue.version !== version) return ok(false)
      await leads.markDormant(row.issueId, row.attempt, deps.clock.now())
      return ok(true)
    })
    if (!marked.ok || !marked.value) continue
    // A lead the Judge's back woke in its Decision wait took a claim for it: asleep again, it has no place to hold.
    await deps.claims.release({ issue: row.issueId, attempt: row.attempt })
    const ended = await deps.terminals.quiesce(name)
    if (ended.ok) dormant++
  }
  return dormant
}
