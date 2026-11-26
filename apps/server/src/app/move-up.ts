import { moveUpWhy, STRONG_ROLE, stepOf } from '../domains/leads/light.ts'
import type { QualityStore } from '../domains/quality/store.ts'
import { OUTLIVES_CLOSE } from '../domains/work/effects.ts'
import { movable } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { IssueId } from '../kernel/ids.ts'
import { withoutAwaitedBlocks } from '../kernel/backoff.ts'
import { key } from '../kernel/keys.ts'
import { ok, type Result } from '../kernel/result.ts'
import { type IssueWriteError, type Recorded, recordIn, type WriteDeps } from './issues.ts'

const attemptOf = (payload: unknown): number | null => {
  const value = (payload as { attempt?: unknown } | null)?.attempt
  return typeof value === 'number' ? value : null
}

/**
 * Moves a struggling light lead up, inside the caller's transaction, right after what it struggled with was stored: its
 * second stall (a block after a backoff not counted) or one that says it is out of its depth, its second refused ship, or a regression of its first watch
 * (`regressedWatch`: the caller records `moved_up` in place of the `regressed` it would send). Reads the attempt from the
 * Issue's events and the refused ships from quality. Null: the rule does not move it, and nothing was written.
 */
export async function moveUpIfDue(
  /** `quality` absent: the trigger is a regression, whose caller has no quality store; earlier refusals moved it up already */
  stores: { work: WorkStore; quality?: Pick<QualityStore, 'refusedShips'> },
  deps: WriteDeps,
  input: { issueId: IssueId; regressedWatch?: number | null; detail?: string },
): Promise<Result<Recorded | null, IssueWriteError>> {
  const history = await stores.work.history(input.issueId)
  if (!history) return ok(null)
  const issue = replay(input.issueId, history)
  // Only a lead the light rule seated, or one whose filed seat asked for it (`moveUp`): any other filed seat is the filer's,
  // and moving it up would start it there again.
  const step = stepOf(issue.ranOn)
  if (issue.state === 'closed' || !movable(issue) || !step) return ok(null)
  const stalls = withoutAwaitedBlocks(history).filter(
    (record) =>
      record.kind === 'stalled' &&
      attemptOf(record.payload) === issue.attempt &&
      (record.payload as { cause?: unknown }).cause !== 'wall',
  )
  const depth = stalls.findLast((record) => (record.payload as { depth?: unknown }).depth === true)
  const why = moveUpWhy({
    step,
    stalls: stalls.length,
    outOfDepth: depth !== undefined,
    shipRefusals: stores.quality ? await stores.quality.refusedShips(input.issueId, issue.attempt) : 0,
    regressedWatch: input.regressedWatch ?? null,
  })
  if (!why) return ok(null)
  // The lead row's step goes to the strong row with a handover: an out-of-depth block's `--reason` is it, and for any other
  // sign the factory asks the leaving lead once (the note is planned with the event; the finalize waits for the answer).
  const handover = step === 'lead' ? (depth?.payload as { detail?: unknown } | undefined)?.detail : undefined
  const lead =
    step === 'lead'
      ? {
          to: STRONG_ROLE,
          ...(typeof handover === 'string' && handover.trim()
            ? { handover: handover.trim().slice(0, MAX_HANDOVER_CHARS) }
            : { ask: 1 as const }),
        }
      : {}
  const eventKey = key('moved_up', input.issueId, issue.attempt)
  const recorded = await recordIn(stores.work, deps, {
    issueId: input.issueId,
    key: eventKey,
    event: {
      kind: 'moved_up',
      payload: { attempt: issue.attempt, why: whyWith(why, input.detail), ...lead },
      actor: 'factory',
    },
  })
  if (!recorded.ok) return recorded
  // As a close does: a note still owed to the leaving lead would hold the finalize behind it (the outbox runs an Issue's
  // effects in order), and the next lead reads every note in its brief anyway. The note that asks for the handover stays.
  if (recorded.value.result === 'applied') {
    await stores.work.cancelOpenEffects(
      input.issueId,
      OUTLIVES_CLOSE,
      deps.clock.now(),
      'ask' in lead ? [key('note_lead', input.issueId, recorded.value.issue.version)] : [],
    )
  }
  return ok(recorded.value)
}

/** The longest handover the event keeps: an out-of-depth block's reason, as the next lead's brief quotes it. */
const MAX_HANDOVER_CHARS = 4_000

/** The rule's reason, and what broke when a regression moved it: the next lead reads both in its brief. */
const whyWith = (why: string, detail: string | undefined): string =>
  (detail?.trim() ? `${why}: ${detail.trim()}` : why).slice(0, 2_000)
