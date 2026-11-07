import { noteText } from '../domains/leads/note.ts'
import { leadKey } from '../domains/leads/names.ts'
import { deriveSession } from '../domains/leads/session.ts'
import type { Delivery } from '../domains/leads/ports.ts'
import type { EffectOf } from '../domains/work/effects.ts'
import type { IssueId } from '../kernel/ids.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import { leadGone } from './leads-start.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

type NoteEffect = EffectOf<'note_lead'> & { issueId: IssueId }

type Look = { done: true } | { done: false; delivery: Pick<Delivery, 'claimedAt' | 'text'> }

/**
 * `note_lead`: the Issue's events from `from` to `version` typed into the lead's terminal, once. The effect's key is the
 * delivery's key, claimed before the typing, so a replay finds it: typed already is done, claimed and a turn since is
 * delivered, claimed and nothing since is typed again. A lead mid-turn is asked again until its turn ends (the outbox
 * waits between tries), and typed into its working turn after `forceNoteAfterMs`. A lead whose terminal is gone is the
 * lead gone, and the next attempt's brief carries the notes.
 */
export async function noteLead(deps: LeadDeps, effect: NoteEffect): Promise<Result<void, PortError>> {
  const { issueId: issue, key: deliveryKey } = effect
  const { attempt, from, version } = effect.payload
  const name = leadKey(issue, attempt)

  const looked = await deps.uow.run<Look, never>(async ({ work, leads }) => {
    const loaded = await loadIssue(work, issue)
    if (!loaded || loaded.issue.state === 'closed' || loaded.issue.attempt !== attempt) return ok({ done: true })
    const row = await leads.attempt(issue, attempt)
    // A lead that never started, or is gone, hears nothing: the next attempt's brief carries the notes.
    if (!row?.terminal || row.goneAt) return ok({ done: true })
    const existing = await leads.delivery(deliveryKey)
    if (existing?.typedAt) return ok({ done: true })
    if (existing) {
      // Claimed, never confirmed: a turn that began since proves the lead took it.
      const view = deriveSession(await leads.hookFacts(name))
      if (view.lastTurnAt && view.lastTurnAt > existing.claimedAt) {
        await leads.markTyped(deliveryKey, view.lastTurnAt, false)
        return ok({ done: true })
      }
      return ok({ done: false, delivery: existing })
    }
    const text = noteText(
      issue,
      loaded.history.filter((record) => record.version >= from && record.version <= version),
    )
    const claimedAt = deps.clock.now()
    await leads.claimDelivery({ key: deliveryKey, issueId: issue, attempt, kind: 'note', text, claimedAt })
    return ok({ done: false, delivery: { claimedAt, text } })
  })
  if (!looked.ok) return looked
  if (looked.value.done) return ok(undefined)
  const { delivery } = looked.value

  const found = await deps.terminals.find(name)
  if (!found.ok) return found
  const live = found.value.find((terminal) => terminal.live)
  if (!live) return leadGone(deps, issue, attempt, 'its terminal was gone when a note arrived')

  const force = deps.clock.now().getTime() - delivery.claimedAt.getTime() >= deps.forceNoteAfterMs
  const typed = await deps.terminals.type({ terminal: live.address, text: delivery.text, force })
  if (!typed.ok) return typed
  if (typed.value === 'busy') {
    return err(portError('refused', 'the lead is mid-turn; it hears the note when its turn ends'))
  }
  const at = deps.clock.now()
  const marked = await deps.uow.run(async ({ leads }) => {
    await leads.markTyped(deliveryKey, at, force)
    return ok(undefined)
  })
  return marked.ok ? ok(undefined) : marked
}
