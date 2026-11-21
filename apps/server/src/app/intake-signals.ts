import { type Signal } from '@software-factory/contract'
import { type Alert, type OpenIssue, type Received, type Triaged } from '../domains/intake/model.ts'
import { FINDING_PREFIX } from '../domains/intake/rules.ts'
import { type IssueId } from '../kernel/ids.ts'
import { type Key, key as keyOf } from '../kernel/keys.ts'
import { ok, type Result } from '../kernel/result.ts'
import {
  type Decision,
  dropped,
  eventKeyOf,
  type IntakeError,
  isOpen,
  loadIssue,
  type Out,
  replayedOf,
  type Stores,
  triaged,
  type IntakeDeps,
  type Ledger,
} from './intake-kit.ts'
import { type Alerts } from './intake-alerts.ts'

/** What a signal that is no monitor does: a GitHub issue, a person's request, a loop's finding. */
export function createSignals(d: { deps: IntakeDeps; ledger: Ledger; alerts: Alerts }) {
  const { uow, clock, ids, settings } = d.deps
  const { note, store } = d.ledger
  const { fileNew, coveredBy } = d.alerts

  /** A signal whose fingerprint an Issue still carries: not closed, or filed in the window. */
  async function repeatIn(
    s: Stores,
    r: Received,
    noteKey: (issue: IssueId) => Key,
    stateKey: Key | null,
  ): Promise<Result<Triaged, IntakeError> | null> {
    const now = clock.now()
    const match = await s.intake.latestByFingerprint(r.signal.source, r.signal.fingerprint)
    if (!match) return null
    const issue = await loadIssue(s.work, match.issueId)
    const recent = now.getTime() - match.filedAt.getTime() < settings.fingerprintWindowMs
    if (!issue || (!isOpen(issue) && !recent)) return null
    await s.intake.touchSubject(match.id, { at: now, upAt: match.upAt, repeat: true })
    if (!isOpen(issue)) return ok(dropped('repeat', `it repeats ${match.issueId}, closed within the window`))
    const noted = await note(s, issue.id, noteKey(issue.id), r, 'repeated')
    if (!noted.ok) return noted
    const stored = await store(s, r, stateKey, 'amended', issue.id)
    return ok(triaged('amended', 'repeat', issue.id, stored))
  }

  async function eventIn(s: Stores, r: Received, alert: Alert): Out<Triaged> {
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const prior = await s.intake.signalByKey(evKey)
    if (prior) return ok(replayedOf(prior))
    // One GitHub issue is one subject however often it is labelled: seen once, it is not filed again.
    if (await s.intake.latestSubject(signal.source, alert.subject))
      return ok(dropped('replayed', 'this subject was filed before'))
    const repeat = await repeatIn(s, r, (issue) => keyOf('noted', 'signal', signal.source, alert.subject, issue), evKey)
    if (repeat) return repeat
    const facts = alert.facts as { writeback?: unknown; admitted?: unknown } | null
    const filed = await fileNew(s, r, keyOf('filed', 'signal', signal.source, alert.subject), {
      groupKey: null,
      writeback: facts?.writeback === true,
      admitted: typeof facts?.admitted === 'string' ? facts.admitted : null,
    })
    if (filed.ok && filed.value.outcome === 'filed' && filed.value.detail === 'new') {
      // A held copy of the same subject became work by another road (its label): it is promoted.
      const held = await s.intake.signalByKey(keyOf('held', signal.source, alert.subject))
      if (held?.state === 'held') await s.intake.setSignal(held.id, { state: 'promoted', issueId: filed.value.issue })
    }
    return filed
  }

  async function humanIn(s: Stores, r: Received, decision: Decision): Out<Triaged> {
    const { signal } = r
    // The same words twice are one note (a replay); the same title with other text is a new one the lead must hear.
    const said = new Bun.CryptoHasher('sha256').update(signal.text).digest('hex').slice(0, 12)
    const repeat = await repeatIn(
      s,
      r,
      (issue) => keyOf('noted', 'signal', signal.source, signal.fingerprint, issue, said),
      null,
    )
    if (repeat) return repeat
    if (decision.settled) return coveredBy(s, r, decision, null)
    if (decision.amend) {
      const issue = await loadIssue(s.work, decision.amend)
      if (isOpen(issue)) {
        const noted = await note(
          s,
          issue.id,
          keyOf('noted', 'signal', signal.source, signal.fingerprint, issue.id, said),
          r,
        )
        if (!noted.ok) return noted
        const stored = await store(s, r, null, 'amended', issue.id)
        // The amended Issue carries the fingerprint from now on: the same words again are a repeat, never asked again.
        await keepFingerprint(s, signal, issue.id)
        return ok(triaged('amended', 'matched', issue.id, stored))
      }
    }
    const id = ids.next('signal')
    const filedOut = await fileNew(s, r, keyOf('filed', 'signal', id), { groupKey: null, stateKey: null })
    if (!filedOut.ok || filedOut.value.outcome !== 'filed') return filedOut
    // A person's request has no subject row to match its fingerprint by next time: one is kept for it.
    if (!r.alert && filedOut.value.issue) await keepFingerprint(s, signal, filedOut.value.issue)
    return filedOut
  }

  /** The subject row a stateless signal is found by next time: its fingerprint, or a loop's finding key. */
  async function keepFingerprint(s: Stores, signal: Signal, issueId: IssueId, findingKey?: Key): Promise<void> {
    const now = clock.now()
    await s.intake.insertSubject({
      source: signal.source,
      subject: findingKey ?? signal.fingerprint,
      fingerprint: findingKey ? null : signal.fingerprint,
      issueId,
      groupKey: null,
      filedAt: now,
      lastSeen: now,
      repeats: 0,
      upAt: null,
      writeback: false,
      admitted: null,
    })
  }

  /**
   * A loop's finding is one subject, its key: an open Issue of that key takes it as a note, one filed within the window
   * and closed counts it as a repeat, else it is a new Issue. No text match and no workflow: the key alone decides, so a
   * finding is never folded into an Issue of another subject. A replay finds the amend it made by its key.
   */
  async function findingIn(s: Stores, r: Received, findingKey: Key, repeatWindowMs?: number): Out<Triaged> {
    const { signal } = r
    const now = clock.now()
    const keyed = await s.intake.latestSubject(signal.source, findingKey)
    // An Issue a loop filed before its findings carried a key has only its title's fingerprint row: while it is open it
    // is taken over once under the key (never one that already carries a key), so the first pass after the change notes it
    // instead of filing it twice.
    const adopted = keyed ? null : await s.intake.latestByFingerprint(signal.source, signal.fingerprint)
    const taken =
      adopted && (await s.intake.subjectsOfIssue(adopted.issueId)).some((row) => row.subject.startsWith(FINDING_PREFIX))
    const adoptable = adopted && !taken ? await loadIssue(s.work, adopted.issueId) : null
    if (adopted && isOpen(adoptable)) await keepFingerprint(s, signal, adoptable.id, findingKey)
    const match = keyed ?? (isOpen(adoptable) ? adopted : null)
    const issue = keyed ? await loadIssue(s.work, keyed.issueId) : adoptable
    if (match && isOpen(issue)) {
      const said = new Bun.CryptoHasher('sha256').update(signal.text).digest('hex').slice(0, 12)
      const amendKey = keyOf('amended', 'finding', findingKey, issue.id, said)
      const prior = await s.intake.signalByKey(amendKey)
      if (prior) return ok(replayedOf(prior))
      const noted = await note(s, issue.id, keyOf('noted', 'finding', findingKey, issue.id, said), r, 'repeated')
      if (!noted.ok) return noted
      await s.intake.touchSubject(match.id, { at: now, upAt: match.upAt, repeat: true })
      const stored = await store(s, r, amendKey, 'amended', issue.id)
      return ok(triaged('amended', 'repeat', issue.id, stored))
    }
    // A finding that names its own window counts it from the close; otherwise it is intake's, from the filing.
    const windowMs = repeatWindowMs ?? settings.fingerprintWindowMs
    const since = repeatWindowMs === undefined ? match?.filedAt : (issue?.closedAt ?? match?.filedAt)
    if (match && issue && since && now.getTime() - since.getTime() < windowMs) {
      await s.intake.touchSubject(match.id, { at: now, upAt: match.upAt, repeat: true })
      return ok(dropped('repeat', `it repeats ${match.issueId}, closed within the window`))
    }
    const filed = await fileNew(s, r, keyOf('filed', 'signal', ids.next('signal')), { groupKey: null, stateKey: null })
    if (!filed.ok || filed.value.outcome !== 'filed' || !filed.value.issue) return filed
    await keepFingerprint(s, signal, filed.value.issue, findingKey)
    return filed
  }

  /** The open Issues a loop's finding filed are not an agent's to amend: each answers its own key alone. */
  async function withoutFindings(open: readonly OpenIssue[]): Out<OpenIssue[]> {
    return uow.run(async (s) => {
      const kept: OpenIssue[] = []
      for (const issue of open) {
        const subjects = await s.intake.subjectsOfIssue(issue.id)
        if (!subjects.some((row) => row.subject.startsWith(FINDING_PREFIX))) kept.push(issue)
      }
      return ok(kept)
    })
  }

  return { eventIn, humanIn, findingIn, withoutFindings }
}

export type Signals = ReturnType<typeof createSignals>
