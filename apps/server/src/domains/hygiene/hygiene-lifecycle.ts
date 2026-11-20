import type { ProbeFinding, ProbeRun } from './hygiene-model.ts'

/**
 * The life of a finding after it was filed. A finding is its key (`links:docs/a.md`, `check`) and the Issues that key filed
 * (`loop_findings`); its state is derived from the newest of those Issues and from the probe's verdict in the pass, never
 * stored. One Issue carries every finding a pass of one repo filed (a section per key), so the rules read an Issue's keys
 * together; both are read by the pass before it files anything:
 *
 * - the probe that raised a key ran clean (or found other things) and did not raise it: the key healed. When every key of
 *   the Issue healed, the Issue is closed as healed if no lead has started (the machine closes `healed` only then); a lead
 *   already on it is told once. While one key is still red the Issue stays open and is told which keys healed;
 * - a key is red again and its Issue closed done: the Issue is reopened with the evidence of its red keys (the machine
 *   allows this for 30 days) instead of a second Issue being filed beside it; twice is enough, then the finding is left to
 *   a person.
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
  /** when the Issue was filed */
  filedAt: Date
  closedAt: Date | null
  /** the applied `reopened` events of the Issue */
  reopens: number
}

export type LifecycleAction = 'healed' | 'noted' | 'reopened' | 'kept'

/** One decision of `planLifecycle` about one Issue; the pass applies it (`app/loops/hygiene.ts`) and records what came of it per key. */
export interface LifecycleStep {
  action: LifecycleAction
  /** the first of `keys` */
  key: string
  /** the keys of the Issue this step is about: the healed ones, or the ones red again */
  keys: string[]
  issue: string
  /** the words the Issue is told, or the record keeps */
  why: string
  /** the probe run that spoke for it (heal, note) */
  run?: ProbeRun
}

export interface LifecyclePlan {
  steps: LifecycleStep[]
  /** red keys that must not be filed: their Issue is open, was reopened, is left to a person, or was filed lately and closed */
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

/** A key whose Issue was filed and closed within this long is a repeat, not filed again (intake's default window for a finding). */
const REPEAT_WINDOW_MS = DAY_MS

/**
 * The document judgment's keys the agent must not file again: raised by an agent, never by a probe, a key is never red or green
 * here. Its Issue is its life while it is open, and a repeat within the window of one that closed is not filed again.
 */
export function heldJudgments(issues: readonly FindingIssue[], now: Date): Set<string> {
  return new Set(
    issues
      .filter(
        (entry) =>
          entry.key.startsWith('judgment:') &&
          (entry.state !== 'closed' || now.getTime() - entry.filedAt.getTime() < REPEAT_WINDOW_MS),
      )
      .map((entry) => entry.key),
  )
}

/**
 * What the sweep's verdicts do to the findings already filed. `issues` is the newest Issue of each key of the project; the
 * document judgment's keys are not judged here (an agent read a few documents, not all of them, so absence proves nothing):
 * an Issue that carries one is never closed as healed, and `suppress` names the ones the agent must not file again.
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
  const byIssue = new Map<string, FindingIssue[]>()
  for (const entry of input.issues) {
    byIssue.set(entry.issue, [...(byIssue.get(entry.issue) ?? []), entry])
  }
  for (const heldKey of heldJudgments(input.issues, input.now)) suppress.add(heldKey)
  for (const [issue, entries] of byIssue) {
    const [first] = entries
    if (!first) continue
    const redKeys = entries.filter((entry) => redByKey.has(entry.key))
    if (first.state === 'closed') {
      // A key filed lately whose Issue closed is a repeat: it is not filed anew (what intake's window did per key).
      for (const entry of redKeys) {
        if (input.now.getTime() - entry.filedAt.getTime() < REPEAT_WINDOW_MS) suppress.add(entry.key)
      }
      if (first.outcome !== 'done' || first.closedAt === null) continue
      if (input.now.getTime() - first.closedAt.getTime() > REOPEN_WINDOW_MS) continue
      if (redKeys.length === 0) continue
      for (const entry of redKeys) suppress.add(entry.key)
      const keys = redKeys.map((entry) => entry.key).sort()
      if (first.reopens >= MAX_REOPENS) {
        steps.push({
          action: 'kept',
          key: keys[0] ?? first.key,
          keys,
          issue,
          why: `closed done and found red again after ${first.reopens} reopens: left to a person, no new Issue`,
        })
        continue
      }
      steps.push({
        action: 'reopened',
        key: keys[0] ?? first.key,
        keys,
        issue,
        why: `The hygiene probe is red again at ${input.swept} after this Issue closed done. Evidence:\n${redKeys
          .map((entry) => {
            const finding = redByKey.get(entry.key)
            return `${entry.key} (${finding?.count ?? 0} item(s)):\n${lines(finding)}`
          })
          .join('\n')}`,
      })
      continue
    }
    // An Issue is open on a red key: that is the finding's life. Filing again would only add a note a day to a lead at work.
    for (const entry of redKeys) suppress.add(entry.key)
    const green = entries
      .filter((entry) => !redByKey.has(entry.key) && !entry.key.startsWith('judgment:'))
      .flatMap((entry) => {
        const run = coveringRun(input.runs, entry.key)
        return run ? [{ key: entry.key, run }] : []
      })
    if (green.length === 0) continue
    const keys = green.map((entry) => entry.key).sort()
    const run = green[0]?.run
    const allGreen = green.length === entries.length
    const named = keys.join(', ')
    if (allGreen && (first.state === 'settling' || first.state === 'queued')) {
      steps.push({
        action: 'healed',
        key: keys[0] ?? first.key,
        keys,
        issue,
        why: `the probe ran green at ${input.swept} and does not raise ${named} any more: ${run?.detail ?? ''}`,
        run,
      })
    } else if (first.state !== 'watching') {
      // a lead at work, or an Issue still holding red keys: tell it which keys are green, and that the rest still hold
      const rest = entries.filter((entry) => !keys.includes(entry.key)).map((entry) => entry.key)
      steps.push({
        action: 'noted',
        key: keys[0] ?? first.key,
        keys,
        issue,
        why: [
          `The hygiene probe no longer raises ${named} (green at ${input.swept}: ${run?.detail ?? ''}).`,
          ...(rest.length > 0 ? [`${rest.join(', ')} not green yet.`] : []),
          'If your change did not cause that, check whether the finding still holds before you go on.',
        ].join(' '),
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
