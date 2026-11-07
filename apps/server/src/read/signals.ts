import type { StoredSignal } from '@software-factory/contract'

/**
 * The stored signals as the read token may see them: the text of a signal that did not come from the owner is hidden,
 * since it is outside text (a feedback form, an alert payload, a work repo's message). Ids, kinds and times stay.
 */
export function redactSignals(signals: readonly StoredSignal[]): StoredSignal[] {
  return signals.map((signal) => (signal.trust === 'owner' ? signal : { ...signal, text: '', redacted: true }))
}
