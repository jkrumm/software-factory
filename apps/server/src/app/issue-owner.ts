import { parseLeadKey } from '../domains/leads/names.ts'
import { fence } from '../domains/intake/rules.ts'
import { replay } from '../domains/work/machine.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import {
  type IssueWriteError,
  type IssueWrites,
  type Recorded,
  recordIn,
  recordIssueEvent,
  type WriteDeps,
} from './issues.ts'

type Deps = WriteDeps & { uow: IssueWrites }

/**
 * The owner ends an Issue. The machine records `cancelled`, and its effects finalize the lead, the worktree and the
 * claim; a closed Issue refuses with the machine's reason. The call id (or one made now) is in the key, so a repeated
 * call is one event.
 */
export function cancelIssue(
  deps: Deps,
  input: { issueId: IssueId; reason: string; call?: string | undefined },
): Promise<Result<Recorded, IssueWriteError | PortError>> {
  return recordIssueEvent(deps, {
    issueId: input.issueId,
    key: key('cancelled', input.issueId, input.call ?? deps.ids.next('call')),
    event: { kind: 'cancelled', payload: { reason: input.reason }, actor: 'owner' },
  })
}

/** What a note did. `woken` is null when no wake was asked for. */
export interface NoteOutcome {
  noted: Recorded
  woken: Recorded | null
}

/** Whether an event took effect, on the first call or on the replay of one that did. */
export const took = (recorded: Recorded): boolean =>
  recorded.result === 'applied' || (recorded.result === 'replayed' && recorded.event.result === 'applied')

export interface NoteInput {
  issueId: IssueId
  text: string
  /** `owner` for the owner's token; `factory` for an agent's, whose text the lead reads fenced as data */
  actor: 'owner' | 'factory'
  wake?: boolean | undefined
  call?: string | undefined
}

/**
 * Records `noted`, and with `wake` also `woken` in the same transaction: the note then reaches the lead in the
 * `note_lead` that ends the wait. `noted` itself never wakes. The machine decides the wake: a refusal (a wait that ends
 * with a person's answer, an Issue that is not waiting) leaves the note and is reported in `woken`.
 */
export function noteIssue(deps: Deps, input: NoteInput): Promise<Result<NoteOutcome, IssueWriteError | PortError>> {
  const call = input.call ?? deps.ids.next('call')
  return deps.uow.run<NoteOutcome, IssueWriteError>(async ({ work }) => {
    const noted = await recordIn(work, deps, {
      issueId: input.issueId,
      key: key('noted', input.issueId, input.actor, call),
      event: {
        kind: 'noted',
        payload: { text: input.actor === 'owner' ? input.text : fence(input.text.slice(0, 4_000)) },
        actor: input.actor,
      },
    })
    if (!noted.ok) return noted
    if (!input.wake || !took(noted.value)) return ok({ noted: noted.value, woken: null })
    const woken = await recordIn(work, deps, {
      issueId: input.issueId,
      key: key('woken', input.issueId, 'note', call),
      event: {
        kind: 'woken',
        payload: { since: noted.value.issue.wait?.since ?? 1, detail: 'the owner woke it with a note' },
        actor: 'owner',
      },
    })
    return woken.ok ? ok({ noted: noted.value, woken: woken.value }) : woken
  })
}

export type SessionNoteError = IssueWriteError | { kind: 'no_session'; session: string }

/**
 * A note typed to a lead by its session key (`lead-<n>-<attempt>`). Only the Issue's current attempt has a session:
 * anything else is `no_session`, which the clients read as "no such session".
 */
export async function noteSession(
  deps: Deps,
  input: { session: string; text: string; actor: 'owner' | 'factory'; call?: string | undefined },
): Promise<Result<NoteOutcome, SessionNoteError | PortError>> {
  const parsed = parseLeadKey(input.session)
  if (!parsed) return err({ kind: 'no_session', session: input.session })
  const current = await deps.uow.run<boolean, never>(async ({ work }) => {
    const history = await work.history(parsed.issue)
    return ok(history !== null && replay(parsed.issue, history).attempt === parsed.attempt)
  })
  if (!current.ok) return current
  if (!current.value) return err({ kind: 'no_session', session: input.session })
  return noteIssue(deps, { issueId: parsed.issue, text: input.text, actor: input.actor, call: input.call })
}
