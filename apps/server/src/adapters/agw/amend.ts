import { TriageAnswer, type TriageCandidate, type TriageSettled } from '@software-factory/contract'
import type { ClosedIssue, OpenIssue } from '../../domains/intake/model.ts'
import type { TriageWorkflow } from '../../domains/intake/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'
import type { IssueId } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'

const digest = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16)

/**
 * Intake's `TriageWorkflow` through `factory-triage` in amend mode: a person's or an agent's signal that deterministic
 * matching is unsure about. The answer is checked as the workflow's guard did: an Issue it was not shown is refused, and
 * a refusal is an error (intake files the signal anew, as it does for any unanswered workflow).
 */
export function agwAmend(agw: AgwPort): TriageWorkflow {
  return {
    async amendOrNew({ signal, candidates, settled }) {
      const shown: TriageCandidate[] = candidates.map((c: OpenIssue) => ({
        id: c.id,
        title: scrub(c.title).slice(0, 500) || c.id,
        kind: c.kind,
        state: c.state,
      }))
      const closed: TriageSettled[] = settled.map((c: ClosedIssue) => ({
        id: c.id,
        title: scrub(c.title).slice(0, 500) || c.id,
        outcome: c.outcome.slice(0, 40) || 'closed',
        reason: c.reason === null ? null : scrub(c.reason).slice(0, 300),
      }))
      const text = scrub(signal.text).slice(0, 8_000)
      const answered = await agw.run({
        workflow: 'factory-triage',
        input: {
          mode: 'amend',
          repo: signal.repo ?? 'unknown',
          candidates: shown,
          settled: closed,
          signal: {
            title: scrub(signal.title).slice(0, 500),
            text,
            source: signal.source,
            kind: signal.kind,
            origin: signal.origin,
          },
        },
        key: key(
          'triage',
          'amend',
          signal.source,
          signal.fingerprint,
          digest(`${signal.title}\n${text}\n${closed.map((c) => c.id).join(',')}`),
        ),
        output: TriageAnswer,
      })
      if (!answered.ok) return answered
      const { amend, after, reason } = answered.value
      const settledId = answered.value.settled ?? null
      if (after.length > 0) return err(portError('refused', 'an amend answer names no edges'))
      if (settledId !== null) {
        if (!closed.some((c) => c.id === settledId)) {
          return err(portError('refused', `${settledId} is not a settled Issue it was shown`))
        }
        if (amend !== null) return err(portError('refused', 'an answer is either an amend or settled, not both'))
        return ok({ amend: null, settled: settledId as IssueId, reason })
      }
      if (amend === null) return ok({ amend: null, settled: null, reason })
      if (!shown.some((c) => c.id === amend)) return err(portError('refused', `${amend} is not an Issue it was shown`))
      return ok({ amend: amend as IssueId, settled: null, reason })
    },
  }
}
