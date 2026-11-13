import type { LoginErrands } from '../domains/leads/ports.ts'
import { err, ok, portError } from '../kernel/result.ts'
import type { CheckpointUses } from './checkpoints-uses.ts'

/** The Errand's own source name: the Console shows who asks. */
export const LOGIN_ERRAND_SOURCE = 'factory-accounts'

/**
 * The Errand "log in account X" on the checkpoints' use cases: a standalone request keyed on the account, so a second lead
 * on the same account is the same Errand (the same words are a replay) and one open request per account holds. It names the
 * command and no check: the picker still says the account is signed in when its login has been revoked, so only the owner's
 * word closes it, and that closing is what the leads' pass reads as "the account answers again".
 */
export function loginErrands(uses: Pick<CheckpointUses, 'requestErrand' | 'errands'>): LoginErrands {
  return {
    async raise({ account, key, label }) {
      const raised = await uses.requestErrand({
        raw: {
          text: `Log in account ${account}\nA lead's turn ended on ${label}: the account's login no longer works. Nothing new starts on it and its leads wait; the factory moves nothing. Log in again, then mark this done: its leads are resumed.`,
          command: `claude-relogin ${account} --machine mini`,
          key,
          source: LOGIN_ERRAND_SOURCE,
          where: 'macbook',
          expires: 'never',
        },
      })
      return raised.ok
        ? ok(undefined)
        : err(portError('refused', `${raised.error.kind}: ${JSON.stringify(raised.error)}`))
    },
    async open() {
      const listed = await uses.errands({ open: true, limit: 500 })
      if (!listed.ok) return err(portError('unreadable', 'the open Errands could not be read'))
      return ok(new Set(listed.value.flatMap((errand) => (errand.requestKey ? [errand.requestKey] : []))))
    },
  }
}
