import { type Received, type Triaged } from '../domains/intake/model.ts'
import { type IssueId } from '../kernel/ids.ts'
import { key as keyOf } from '../kernel/keys.ts'
import { ok } from '../kernel/result.ts'
import {
  isOpen,
  loadIssue,
  type Out,
  replayedOf,
  type Stores,
  triaged,
  type IntakeDeps,
  type Ledger,
} from './intake-kit.ts'

const PROBE_REASON = 'marked as a probe'

/** What waits for the owner: a probe is stored dismissed, outside text is held until promoted. */
export function createQuarantine(d: { deps: IntakeDeps; ledger: Ledger }) {
  const { clock, settings } = d.deps
  const { note, store } = d.ledger

  /** A lead's own test signal: stored dismissed, never held, never work. A replay finds the stored one. */
  async function probeIn(s: Stores, r: Received): Out<Triaged> {
    const key = keyOf('probe', r.signal.source, r.signal.fingerprint)
    const existing = await s.intake.signalByKey(key)
    const id =
      existing?.id ??
      (await store(s, r, key, 'dismissed', null, { reason: PROBE_REASON, by: 'probe', at: clock.now() }))
    return ok(triaged('dropped', 'probe', null, id, 'marked as a probe: stored dismissed, never shown to the owner'))
  }

  async function hold(
    s: Stores,
    r: Received,
    again?: IssueId,
    reason = 'outside text waits for the owner or the Judge',
  ): Out<Triaged> {
    const base = r.alert
      ? ['held', r.signal.source, r.alert.subject]
      : again
        ? ['held', r.signal.source, r.signal.fingerprint, again]
        : ['held', r.signal.source, r.signal.fingerprint]
    // A dismissed report is answered; the next one with the same words is a new report, under the key after it.
    let heldKey = keyOf(...base)
    let existing = await s.intake.signalByKey(heldKey)
    while (existing?.state === 'dismissed') {
      heldKey = keyOf(...base, 'after', existing.id)
      existing = await s.intake.signalByKey(heldKey)
    }
    if (existing) return ok({ ...replayedOf(existing), outcome: 'held' })
    const id = await store(s, r, heldKey, 'held', null)
    return ok(triaged('held', 'quarantined', null, id, reason))
  }

  /**
   * Outside text: held until promoted. The one exception is a complaint already promoted to an Issue that is still open,
   * which amends it (the note is fenced data); one whose Issue is closed is held again as new, under a key of that Issue
   * so a replay finds it. A duplicate of a still-quarantined signal is the held one (a replay, no second row).
   */
  async function outsideIn(s: Stores, r: Received): Out<Triaged> {
    const { signal } = r
    if (r.alert) return hold(s, r)
    await s.intake.lock(`outside:${signal.source}:${signal.fingerprint}`)
    const match = await s.intake.latestByFingerprint(signal.source, signal.fingerprint)
    if (!match) return hold(s, r)
    const issue = await loadIssue(s.work, match.issueId)
    if (!isOpen(issue)) return hold(s, r, match.issueId)
    const said = new Bun.CryptoHasher('sha256').update(signal.text).digest('hex').slice(0, 12)
    const amendKey = keyOf('amended', 'signal', signal.source, signal.fingerprint, issue.id, said)
    const prior = await s.intake.signalByKey(amendKey)
    if (prior) return ok(replayedOf(prior))
    const noted = await note(
      s,
      issue.id,
      keyOf('noted', 'signal', signal.source, signal.fingerprint, issue.id, said),
      r,
      'repeated',
    )
    if (!noted.ok) return noted
    await s.intake.touchSubject(match.id, { at: clock.now(), upAt: match.upAt, repeat: true })
    const stored = await store(s, r, amendKey, 'amended', issue.id)
    return ok(triaged('amended', 'matched', issue.id, stored))
  }

  /** Whether `repeatIn` would answer this signal: an Issue carries its fingerprint, open or closed within the window. */
  async function fingerprintKnown(s: Stores, r: Received): Promise<boolean> {
    const match = await s.intake.latestByFingerprint(r.signal.source, r.signal.fingerprint)
    if (!match) return false
    const issue = await loadIssue(s.work, match.issueId)
    const recent = clock.now().getTime() - match.filedAt.getTime() < settings.fingerprintWindowMs
    return issue !== null && (isOpen(issue) || recent)
  }

  return { probeIn, hold, outsideIn, fingerprintKnown }
}

export type Quarantine = ReturnType<typeof createQuarantine>
