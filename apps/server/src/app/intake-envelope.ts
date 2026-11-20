import { cleanText, MAX_TITLE_CHARS, type Signal, type SignalRequest } from '@software-factory/contract'
import { fingerprintOf, originOf } from '../domains/intake/rules.ts'
import { ok, type Result } from '../kernel/result.ts'
import { type IntakeRefusal, refuse, type RequestCaller } from './intake-kit.ts'

/** The one source the signal token files as: Hermes, carrying the owner's words. */
const SIGNAL_SOURCE = 'owner:hermes'

const TRUST_RANK = { outside: 0, agent: 1, owner: 2 } as const

/**
 * The envelope for what a person or an agent put in. The caller's token decides the trust: the owner's is `owner`, an
 * agent's is `agent`. The claimed `from` is a source label that may lower the trust (an agent's token under
 * `feedback:<app>` is `outside`) and never raises it: `owner*` under an agent's token is refused. The signal token is
 * the owner's voice through Hermes and nothing else: its `from` is exactly `owner:hermes` (trust `owner`), any other is refused.
 */
export function envelopeOfRequest(body: SignalRequest, caller: RequestCaller): Result<Signal, IntakeRefusal> {
  if (caller === 'signal' && body.from !== SIGNAL_SOURCE) {
    return refuse('trust_refused', `the signal token may file only as ${SIGNAL_SOURCE}, not as ${body.from}`)
  }
  const [kind, who] = body.from.split(':') as [string, string | undefined]
  const claimed = kind === 'owner' ? 'owner' : kind === 'agent' ? 'agent' : 'outside'
  // The orchestrator files with the owner's ceiling: it is his delegate, and the trust column is not widened for it.
  const ceiling =
    caller === 'owner' || caller === 'orchestrator' || caller === 'signal'
      ? 'owner'
      : caller === 'agent'
        ? 'agent'
        : 'outside'
  if (TRUST_RANK[claimed] > TRUST_RANK[ceiling]) {
    return refuse('trust_refused', `the ${caller} token may not file a signal as ${body.from}`)
  }
  const trust = claimed
  const repo = trust === 'agent' ? (body.repo ?? who ?? null) : trust === 'owner' ? (body.repo ?? null) : null
  return ok({
    source: body.from,
    kind: body.kind,
    origin: originOf(body.from),
    trust,
    repo: repo ?? null,
    fingerprint: fingerprintOf(repo, cleanText(body.title)),
    title: cleanText(body.title).slice(0, MAX_TITLE_CHARS) || 'untitled',
    text: cleanText(body.text),
    link: body.link ? cleanText(body.link) : null,
    madeBy: null,
    probe: body.probe,
  })
}
