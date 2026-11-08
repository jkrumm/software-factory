import {
  type CiRun,
  type Finding,
  type HeartbeatFact,
  type IdleLead,
  type MigrationSnapshot,
  type RegressionFact,
  type SelfwatchRow,
  subjectKeyOf,
  type WaitFact,
} from './selfwatch-model.ts'

/** One pass files at most this many signals; what is left over is found again on the next tick. */
export const MAX_SELFWATCH_FILINGS = 5

/** A wait past its exit by this long with no event is overdue (`FACTORY_SELFWATCH_GRACE_MS` overrides). */
export const DEFAULT_WAIT_GRACE_MS = 10 * 60_000

/** The most evidence lines a signal carries, header and reproduce line included. */
const MAX_LINES = 8
const MAX_LISTED = 3

/** A run that ended in one of these is red; `cancelled`, `neutral`, `skipped` and the like say nothing about the code. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])

const short = (sha: string): string => sha.slice(0, 7)
const iso = (date: Date): string => date.toISOString()
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const oneLine = (text: string, max = 160): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

// ---- 1. ci_red ------------------------------------------------------------------------------------------------------------

/**
 * A workflow whose two newest runs that said something (a success or a red conclusion) are both red. A cancelled, neutral
 * or skipped run is left out: it neither breaks nor extends the streak.
 */
export function ciFindings(runs: readonly CiRun[], branch: string): Finding[] {
  const byWorkflow = new Map<string, CiRun[]>()
  for (const run of runs) {
    if (run.conclusion !== 'success' && !RED_CONCLUSIONS.has(run.conclusion)) continue
    byWorkflow.set(run.workflow, [...(byWorkflow.get(run.workflow) ?? []), run])
  }
  const found: Finding[] = []
  for (const [workflow, list] of [...byWorkflow].sort(([a], [b]) => byText(a, b))) {
    const newest = [...list].sort((a, b) => byText(b.at, a.at) || byText(b.id, a.id)).slice(0, 2)
    if (newest.length < 2 || !newest.every((run) => RED_CONCLUSIONS.has(run.conclusion))) continue
    found.push({
      kind: 'ci_red',
      subject: workflow,
      title: `Self-watch: CI is red on ${branch} for the workflow ${workflow}`,
      facts: newest.map((run) => `run ${run.id} at ${short(run.sha)} concluded ${run.conclusion}: ${run.url}`),
      context: [`Branch: ${branch}`, `The two newest completed runs of ${workflow} both failed (newest first).`],
      reproduce: `make check on ${branch} at ${short(newest[0]?.sha ?? '')}, or open the runs above`,
    })
  }
  return found
}

// ---- 2. migration_clash ---------------------------------------------------------------------------------------------------

const MIGRATION_NUMBER = /^(\d{4})_/

/** A number carried by two or more distinct file names, on the default branch or on any ref; `shared` numbers are applied twins and are left. */
export function migrationFindings(snapshot: MigrationSnapshot, shared: ReadonlySet<string>): Finding[] {
  const carriers = new Map<string, Map<string, Set<string>>>()
  const add = (name: string, ref: string) => {
    const number = MIGRATION_NUMBER.exec(name)?.[1]
    if (!number || shared.has(number)) return
    const names = carriers.get(number) ?? new Map<string, Set<string>>()
    names.set(name, (names.get(name) ?? new Set()).add(ref))
    carriers.set(number, names)
  }
  for (const name of snapshot.base) add(name, 'origin/master')
  for (const { ref, added } of snapshot.refs) for (const name of added) add(name, ref)

  const found: Finding[] = []
  for (const [number, names] of [...carriers].sort(([a], [b]) => byText(a, b))) {
    if (names.size < 2) continue
    const files = [...names.keys()].sort(byText)
    found.push({
      kind: 'migration_clash',
      subject: number,
      // subject first and few fixed words: intake amends an open Issue whose title shares 60% of its words, and two clashes are two Issues
      title: `Self-watch: ${files.join(' and ')} clash`,
      facts: [
        `number ${number} is taken by ${files.length} files`,
        ...files.slice(0, MAX_LINES - 4).map((name) => {
          const refs = [...(names.get(name) ?? [])].sort(byText)
          const listed = refs.slice(0, MAX_LISTED).join(', ')
          return `${name} on ${listed}${refs.length > MAX_LISTED ? ` and ${refs.length - MAX_LISTED} more` : ''}`
        }),
      ],
      context: ['The loader refuses a repeated number, so the second one to merge stops the next start.'],
      reproduce:
        'git ls-tree --name-only origin/master apps/server/migrations/; git diff --name-only --diff-filter=A origin/master...<ref>',
    })
  }
  return found
}

// ---- 3. wait_overdue ------------------------------------------------------------------------------------------------------

/**
 * The time a wait should have ended, by the predicates the planning pass wakes with (`wakeTimers`, `wakeDependents`): a
 * timer at its `until`, a dependency once every Issue it is after has closed (the last close). Null while one is still open.
 */
export function waitExit(wait: WaitFact): Date | null {
  if (wait.reason === 'timer') return wait.until === null ? null : new Date(Date.parse(wait.until))
  if (wait.after.some((a) => a.closedAt === null)) return null
  const closes = wait.after.flatMap((a) => (a.closedAt ? [a.closedAt.getTime()] : []))
  return new Date(closes.length > 0 ? Math.max(...closes) : wait.sinceAt.getTime())
}

/** A wait whose exit is more than `graceMs` past, with the Issue still waiting: the event that ends it never came. */
export function waitFindings(waits: readonly WaitFact[], now: Date, graceMs: number): Finding[] {
  const found: Finding[] = []
  for (const wait of waits) {
    const exit = waitExit(wait)
    if (!exit || Number.isNaN(exit.getTime()) || exit.getTime() + graceMs >= now.getTime()) continue
    found.push({
      kind: 'wait_overdue',
      subject: `${wait.issue}:${wait.reason}`,
      title: `Self-watch: ${wait.reason} wait overdue for ${wait.issue} ${oneLine(wait.title, 200)}`,
      facts: [
        `${wait.issue} waits for a ${wait.reason}, since v${wait.since} (${iso(wait.sinceAt)})`,
        wait.reason === 'timer'
          ? `until: ${wait.until}`
          : `after: ${wait.after.map((a) => `${a.issue} closed ${a.closedAt ? iso(a.closedAt) : 'never'}`).join(', ')}`,
        `the wait should have ended at ${iso(exit)}`,
      ],
      context: [`Now: ${iso(now)}`, `Grace: ${Math.round(graceMs / 60_000)} min with no waking event`],
      reproduce: `factory issue show ${wait.issue}; factory read loops (planning)`,
    })
  }
  return found
}

// ---- 4. lead_idle ---------------------------------------------------------------------------------------------------------

/** A lead whose session has been quiet longer than the steward's threshold (`idleLeadMs`). */
export function idleFindings(leads: readonly IdleLead[], now: Date, idleLeadMs: number): Finding[] {
  return leads
    .filter((lead) => now.getTime() - lead.idleSince.getTime() > idleLeadMs)
    .map((lead) => ({
      kind: 'lead_idle' as const,
      subject: lead.lead,
      title: `Self-watch: lead ${lead.lead} idle past the steward's threshold on ${oneLine(lead.title, 200)}`,
      facts: [
        `${lead.issue} is working, its lead ${lead.lead} reported nothing`,
        `idle since ${iso(lead.idleSince)}`,
        `threshold: ${Math.round(idleLeadMs / 60_000)} min (FACTORY_STEWARD_IDLE_MS)`,
      ],
      context: [`Now: ${iso(now)}`, `Idle for ${Math.floor((now.getTime() - lead.idleSince.getTime()) / 60_000)} min`],
      reproduce: `factory issue show ${lead.issue}; factory read overview`,
    }))
}

// ---- 5. inert_regression --------------------------------------------------------------------------------------------------

/**
 * A regression whose ship touched only inert paths (documents, text, tests): the ship cannot be its cause. Only a ship
 * whose stored evidence names paths counts; no ship, no paths, or any path a deploy carries is no finding.
 */
export function inertRegressionFindings(
  regressions: readonly RegressionFact[],
  isInert: (path: string) => boolean,
): Finding[] {
  const found: Finding[] = []
  for (const regression of regressions) {
    const { ship } = regression
    if (!ship || ship.deploys || ship.paths.length === 0 || !ship.paths.every(isInert)) continue
    found.push({
      kind: 'inert_regression',
      subject: regression.issue,
      title: `Self-watch: regression after a ship of inert paths only: ${oneLine(regression.title, 200)}`,
      facts: [
        `${regression.issue} regressed: ${oneLine(regression.detail, 200)}`,
        `shipped commits: ${ship.commits.slice(0, MAX_LISTED).map(short).join(', ')}${ship.commits.length > MAX_LISTED ? ` and ${ship.commits.length - MAX_LISTED} more` : ''}`,
        `their paths, all inert: ${ship.paths.slice(0, MAX_LINES).join(', ')}`,
      ],
      context: [
        'No path of the ship is carried by a deploy, so the regression has another cause (a check, the host, master).',
      ],
      reproduce: `factory issue show ${regression.issue}; git show --stat <commit>`,
    })
  }
  return found
}

// ---- 6. heartbeat_stale ---------------------------------------------------------------------------------------------------

/** `tick`: the leads' tick is stale (`tickProblem`); `database`: anything else `healthOf` reports. */
export const heartbeatClass = (reason: string | null): 'tick' | 'database' =>
  reason !== null && (reason.startsWith('no tick has succeeded') || reason.startsWith('the last successful tick'))
    ? 'tick'
    : 'database'

export function heartbeatFindings(heartbeat: HeartbeatFact, now: Date): Finding[] {
  if (heartbeat.ok) return []
  const kind = heartbeatClass(heartbeat.reason)
  return [
    {
      kind: 'heartbeat_stale',
      subject: kind,
      title: `Self-watch: the heartbeat is stale: ${kind === 'tick' ? 'the leads tick has stopped' : 'the database does not answer'}`,
      facts: [`heartbeat class: ${kind}`, `tickAt: ${heartbeat.tickAt ?? 'never'}`],
      // the queue moves when this very signal is filed: it is never part of the evidence
      context: [
        `queueMovedAt: ${heartbeat.queueMovedAt ?? 'never'}`,
        `Reason: ${oneLine(heartbeat.reason ?? 'none')}`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'curl the server GET /health; factory read loops',
    },
  ]
}

// ---- the signal -----------------------------------------------------------------------------------------------------------

/** The evidence's identity: the facts and nothing that moves with the clock. */
export function evidenceHash(finding: Pick<Finding, 'facts'>): string {
  return new Bun.CryptoHasher('sha256').update(finding.facts.join('\n')).digest('hex').slice(0, 16)
}

/** A finding as a signal's text: what was seen, where, how to look again; at most `MAX_LINES` lines. */
export function signalText(finding: Finding, repo: string): string {
  return [
    `Self-watch ${finding.kind} (${finding.subject}) on ${repo}`,
    ...[...finding.facts, ...finding.context].slice(0, MAX_LINES - 2),
    `Reproduce: ${finding.reproduce}`,
  ].join('\n')
}

// ---- the plan -------------------------------------------------------------------------------------------------------------

export interface FileAction {
  finding: Finding
  hash: string
  why: 'new' | 'reappeared' | 'changed'
  /** when this episode of the subject began: the old row's, or now */
  firstSeenAt: Date
}

export interface SelfwatchPlan {
  file: FileAction[]
  /** open rows whose evidence is unchanged: only `last_seen_at` moves */
  touch: string[]
  /** open rows whose condition no longer holds */
  clear: string[]
}

/**
 * Once per subject, amended while it stays open. A new or cleared subject is filed; an open one with the same evidence
 * only moves `last_seen_at`; one whose evidence changed is filed again under the same title (intake's repeat path
 * amends the open Issue); an open row whose subject is absent is cleared. A kind in `unread` was not looked at in this
 * pass: its rows are left as they are.
 */
export function planSelfwatch(
  findings: readonly Finding[],
  rows: readonly SelfwatchRow[],
  now: Date,
  unread: ReadonlySet<string> = new Set(),
): SelfwatchPlan {
  const byKey = new Map(rows.map((row) => [row.subjectKey, row]))
  const seen = new Set<string>()
  const plan: SelfwatchPlan = { file: [], touch: [], clear: [] }
  for (const finding of findings) {
    const subjectKey = subjectKeyOf(finding)
    if (seen.has(subjectKey)) continue
    seen.add(subjectKey)
    const hash = evidenceHash(finding)
    const row = byKey.get(subjectKey)
    if (!row) plan.file.push({ finding, hash, why: 'new', firstSeenAt: now })
    else if (row.clearedAt !== null) plan.file.push({ finding, hash, why: 'reappeared', firstSeenAt: now })
    else if (row.evidenceHash !== hash) plan.file.push({ finding, hash, why: 'changed', firstSeenAt: row.firstSeenAt })
    else plan.touch.push(subjectKey)
  }
  for (const row of rows) {
    if (row.clearedAt === null && !seen.has(row.subjectKey) && !unread.has(row.kind)) plan.clear.push(row.subjectKey)
  }
  return plan
}
