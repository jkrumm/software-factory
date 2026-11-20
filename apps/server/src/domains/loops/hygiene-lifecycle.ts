import type { ProbeFinding, ProbeRun } from './hygiene-model.ts'

/**
 * The life of a finding after it was filed. A finding is its key (`links:docs/a.md`, `check`) and the Issues that key filed
 * (`loop_findings`); its state is derived from the newest of those Issues and from the probe's verdict in the pass, never
 * stored. Two rules, both read by the pass before it files anything:
 *
 * - the probe that raised a key ran clean (or found other things) and did not raise it: the finding healed. Its Issue is
 *   closed as healed when no lead has started (the machine closes `healed` only then); a lead already on it is told once;
 * - the key is red again and its newest Issue closed done: the Issue is reopened with the evidence (the machine allows
 *   this for 30 days) instead of a second Issue being filed beside it; twice is enough, then the finding is left to a person.
 */

const DAY_MS = 86_400_000

/** The machine refuses a reopen 30 days after the close; a day's margin keeps the pass from asking at the edge. */
export const REOPEN_WINDOW_MS = 29 * DAY_MS
/** A finding is reopened at most this often: a lead that closed it done twice and found it red again needs a person. */
const MAX_REOPENS = 2
/** A daily pass becomes a full one when this many commits landed since the last full pass... */
const BUSY_COMMITS = 30
/** ...and the last full pass is at least this old (a repo that merges all day does not get a full sweep every day). */
const BUSY_MIN_AGE_MS = 2 * DAY_MS

/** The newest Issue a key filed, as the pass reads it (`LoopReads.findingIssues`). */
export interface FindingIssue {
  key: string
  issue: string
  state: 'settling' | 'queued' | 'working' | 'waiting' | 'watching' | 'closed'
  outcome: 'done' | 'healed' | 'dropped' | 'cancelled' | null
  closedAt: Date | null
  /** the applied `reopened` events of the Issue */
  reopens: number
}

export type LifecycleAction = 'healed' | 'noted' | 'reopened' | 'kept'

/** One decision of `planLifecycle`; the pass applies it (`app/loops/hygiene.ts`) and records what came of it. */
export interface LifecycleStep {
  action: LifecycleAction
  key: string
  issue: string
  /** the words the Issue is told, or the record keeps */
  why: string
  /** the probe run that spoke for it (heal, note) */
  run?: ProbeRun
}

export interface LifecyclePlan {
  steps: LifecycleStep[]
  /** red keys that must not be filed: their Issue was reopened, or is left to a person */
  suppress: Set<string>
}

/** An `unjudged` entry that means every key of the run. */
const ALL = '*'

/** A run speaks for a key when it ended with a verdict (clean or found), the key is its own or under it, and the run did not leave that key unjudged. */
function coveringRun(runs: readonly ProbeRun[], key: string): ProbeRun | undefined {
  const under = (prefix: string): boolean => key === prefix || key.startsWith(`${prefix}:`)
  return runs.find(
    (run) =>
      (run.outcome === 'clean' || run.outcome === 'found') &&
      run.covers !== undefined &&
      under(run.covers) &&
      !(run.unjudged ?? []).some((unjudged) => unjudged === ALL || unjudged === key),
  )
}

/**
 * The figure of a key in this sweep: the count of its red finding, 0 when a run that judged it did not raise it, `undefined`
 * when no run spoke for it (the probe did not run in this scope, or failed): the finding's Issue waits for a sweep that does.
 */
export function figureNow(
  sweep: { findings: readonly ProbeFinding[]; runs: readonly ProbeRun[] },
  key: string,
): number | undefined {
  const red = sweep.findings.find((finding) => finding.key === key)
  if (red) return red.count
  return coveringRun(sweep.runs, key) ? 0 : undefined
}

const lines = (finding: ProbeFinding | undefined): string =>
  finding ? finding.lines.map((line) => `  ${line}`).join('\n') : ''

/**
 * What the sweep's verdicts do to the findings already filed. `issues` is the newest Issue of each key of the project; the
 * document judgment's keys are not judged here (an agent read a few documents, not all of them, so absence proves nothing).
 */
export function planLifecycle(input: {
  red: readonly ProbeFinding[]
  runs: readonly ProbeRun[]
  issues: readonly FindingIssue[]
  now: Date
  swept: string
}): LifecyclePlan {
  const redByKey = new Map(input.red.map((finding) => [finding.key, finding]))
  const steps: LifecycleStep[] = []
  const suppress = new Set<string>()
  for (const entry of input.issues) {
    if (entry.key.startsWith('judgment:')) continue
    const finding = redByKey.get(entry.key)
    if (finding) {
      // An Issue is open on it: that is the finding's life. Filing again would only add a note a day to a lead at work.
      if (entry.state !== 'closed') {
        suppress.add(entry.key)
        continue
      }
      if (entry.outcome !== 'done' || entry.closedAt === null) continue
      if (input.now.getTime() - entry.closedAt.getTime() > REOPEN_WINDOW_MS) continue
      suppress.add(entry.key)
      if (entry.reopens >= MAX_REOPENS) {
        steps.push({
          action: 'kept',
          key: entry.key,
          issue: entry.issue,
          why: `closed done and found red again after ${entry.reopens} reopens: left to a person, no new Issue`,
        })
        continue
      }
      steps.push({
        action: 'reopened',
        key: entry.key,
        issue: entry.issue,
        why: `The hygiene probe is red again at ${input.swept} after this Issue closed done. Evidence (${finding.count} item(s)):\n${lines(finding)}`,
      })
      continue
    }
    if (entry.state === 'closed') continue
    const run = coveringRun(input.runs, entry.key)
    if (!run) continue
    if (entry.state === 'settling' || entry.state === 'queued') {
      steps.push({
        action: 'healed',
        key: entry.key,
        issue: entry.issue,
        why: `the probe ran green at ${input.swept} and does not raise ${entry.key} any more: ${run.detail}`,
        run,
      })
    } else if (entry.state === 'working' || entry.state === 'waiting') {
      steps.push({
        action: 'noted',
        key: entry.key,
        issue: entry.issue,
        why: `The hygiene probe no longer raises ${entry.key} (green at ${input.swept}: ${run.detail}). If your change did not cause that, check whether the finding still holds before you go on.`,
        run,
      })
    }
  }
  return { steps, suppress }
}

/** A daily pass is promoted to a full one for a busy repo: many commits since the last full pass, which is not new. */
export function isBusy(input: { commits: number | null; lastFullAt: Date | null; now: Date }): boolean {
  if (input.commits === null || input.lastFullAt === null) return false
  return input.commits >= BUSY_COMMITS && input.now.getTime() - input.lastFullAt.getTime() >= BUSY_MIN_AGE_MS
}
