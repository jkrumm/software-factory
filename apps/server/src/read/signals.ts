import type { StoredSignal } from '@software-factory/contract'
import { REDACTED_TITLE } from './work.ts'

/**
 * The stored signals as the read token may see them: ids, kinds, times and states stay; the words go (title, text, link
 * and repo). A signal is outside text (a feedback form, an alert payload) or the owner's request in a repo the factory may
 * hold only as a work repo, and the signal list does not know which; the read models (`needs`) carry the held ones with
 * the work-repo rule.
 */
export function redactSignals(signals: readonly StoredSignal[]): StoredSignal[] {
  return signals.map((signal) => ({
    ...signal,
    title: REDACTED_TITLE,
    text: '',
    link: null,
    repo: null,
    dismissedReason: null,
    redacted: true,
  }))
}
