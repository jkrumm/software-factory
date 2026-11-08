import type { ScreenAnswer, ScreenRequest } from '@software-factory/contract'
import type { OpenIssue } from './model.ts'
import type { Screening, SignalRow } from './ports.ts'

export const NOT_SCREENED: Screening = { note: null, at: null, attempts: 0, retryAt: null }

/** A held signal whose screening failed this often is left unscreened for good: the owner sees it as it is. */
export const MAX_SCREEN_ATTEMPTS = 5
/** Signals the Judge looks at in one pass. */
export const SCREEN_BATCH = 10
/** Open Issues and project names a screening is shown. */
export const MAX_SCREEN_ISSUES = 40
export const MAX_SCREEN_PROJECTS = 60

const BACKOFF_BASE_MS = 10 * 60_000
const BACKOFF_CAP_MS = 6 * 3_600_000

/** A failed call waits before the next: `attempt` is the 0-based index of the call that failed. */
export const screenBackoffMs = (attempt: number): number => Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)

/** The one signal as the workflow is shown it: outside text scrubbed, bounded, and nothing in it picks a repo or a command. */
export function screenRequest(
  row: SignalRow,
  open: readonly OpenIssue[],
  projects: readonly string[],
  clean: (text: string) => string,
): ScreenRequest {
  const signal = row.received.signal
  return {
    signal: {
      id: row.id,
      source: signal.source,
      kind: signal.kind,
      origin: signal.origin,
      repo: signal.repo,
      title: clean(signal.title).slice(0, 500) || row.id,
      text: clean(signal.text).slice(0, 8_000),
      link: signal.link === null ? null : clean(signal.link).slice(0, 1024),
      receivedAt: row.receivedAt.toISOString(),
    },
    openIssues: open.slice(0, MAX_SCREEN_ISSUES).map((issue) => ({
      id: issue.id,
      title: clean(issue.title).slice(0, 500) || issue.id,
      kind: issue.kind,
      state: issue.state,
    })),
    projects: projects.slice(0, MAX_SCREEN_PROJECTS),
  }
}

/** The repo a promote would file in: the signal's own, else the one the Judge named. */
export const screenTarget = (signalRepo: string | null, answer: ScreenAnswer): string | null =>
  signalRepo ?? answer.repo

export type ScreenChecked =
  | { action: 'promote'; repo: string }
  | { action: 'dismiss'; reason: string }
  /** nothing is promoted or dismissed; `note` is what the owner reads (the Judge's recommendation, or why it was downgraded) */
  | { action: 'leave'; note: string }
  /** an answer that cannot be acted on at all: counted as a failed call */
  | { action: 'refused'; why: string }

const NOTE_MAX = 600

/**
 * The answer is held to what it was shown before anything is done. `repoKnown` says whether `screenTarget` is a project the
 * factory knows that is not a work repo. A claim the Judge cannot back (an unknown repo, a duplicate it was not shown)
 * downgrades to `leave`: a signal is never promoted or dismissed on a claim that does not hold.
 */
export function checkScreen(
  shown: { signalRepo: string | null; openIssues: readonly { id: string }[]; repoKnown: boolean },
  answer: ScreenAnswer,
): ScreenChecked {
  const reason = answer.reason.trim()
  const downgrade = (why: string): ScreenChecked => ({ action: 'leave', note: `${why}: ${reason}`.slice(0, NOTE_MAX) })

  if (answer.verdict === 'leave') {
    const recommendation = answer.recommendation?.trim()
    return { action: 'leave', note: (recommendation || reason).slice(0, NOTE_MAX) }
  }

  if (answer.verdict === 'promote') {
    const repo = screenTarget(shown.signalRepo, answer)
    if (repo === null) return downgrade('screen named no repo')
    if (!shown.repoKnown) return downgrade('screen named an unknown repo')
    return { action: 'promote', repo }
  }

  if (reason.length === 0) return { action: 'refused', why: 'a dismissal needs a reason' }
  if (answer.duplicateOf === null) return { action: 'dismiss', reason }
  if (!shown.openIssues.some((issue) => issue.id === answer.duplicateOf)) {
    return downgrade(`screen claimed a duplicate of ${answer.duplicateOf}, which it was not shown`)
  }
  return { action: 'dismiss', reason: `${reason} (duplicate of ${answer.duplicateOf})` }
}
