import { TriageAnswer, type TriageCandidate } from '@software-factory/contract'
import type { OpenIssue } from '../../domains/intake/model.ts'
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
    async amendOrNew({ signal, candidates }) {
      const shown: TriageCandidate[] = candidates.map((c: OpenIssue) => ({
        id: c.id,
        title: scrub(c.title).slice(0, 500) || c.id,
        kind: c.kind,
        state: c.state,
      }))
      const text = scrub(signal.text).slice(0, 8_000)
      const answered = await agw.run({
        workflow: 'factory-triage',
        input: {
          mode: 'amend',
          repo: signal.repo ?? 'unknown',
          candidates: shown,
          signal: {
            title: scrub(signal.title).slice(0, 500),
            text,
            source: signal.source,
            kind: signal.kind,
            origin: signal.origin,
          },
        },
        key: key('triage', 'amend', signal.source, signal.fingerprint, digest(`${signal.title}\n${text}`)),
        output: TriageAnswer,
      })
      if (!answered.ok) return answered
      const { amend, after } = answered.value
      if (after.length > 0) return err(portError('refused', 'an amend answer names no edges'))
      if (amend === null) return ok({ amend: null })
      if (!shown.some((c) => c.id === amend)) return err(portError('refused', `${amend} is not an Issue it was shown`))
      return ok({ amend: amend as IssueId })
    },
  }
}
