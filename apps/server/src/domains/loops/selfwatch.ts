import { isRedConclusion } from '../../kernel/checks.ts'
import {
  type CiRun,
  type Finding,
  type HeartbeatFact,
  type HostMinute,
  type IdleLead,
  type MigrationSnapshot,
  type ProcessMinute,
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

const short = (sha: string): string => sha.slice(0, 7)
const iso = (date: Date): string => date.toISOString()
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const oneLine = (text: string, max = 160): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
/**
 * An id in words: intake's fingerprint drops digits, so "issue_470" and "issue_471" would be one subject. A subject Issue's
 * own title stays out of the title too (intake amends an open Issue whose title shares 60% of its words, and the subject
 * Issue is open): the title names the Issue by its spelled id, the text carries its title.
 */
const spelled = (id: string): string =>
  id
    .replace(/\d/g, (digit) => ` ${DIGIT_WORDS[Number(digit)]} `)
    .replace(/\s+/g, ' ')
    .trim()

// ---- 1. ci_red ------------------------------------------------------------------------------------------------------------

/**
 * A workflow whose two newest runs that said something (a success or a red conclusion) are both red. A cancelled, neutral
 * or skipped run is left out: it neither breaks nor extends the streak.
 */
export function ciFindings(runs: readonly CiRun[], branch: string): Finding[] {
  const byWorkflow = new Map<string, CiRun[]>()
  for (const run of runs) {
    if (run.conclusion !== 'success' && !isRedConclusion(run.conclusion)) continue
    byWorkflow.set(run.workflow, [...(byWorkflow.get(run.workflow) ?? []), run])
  }
  const found: Finding[] = []
  for (const [workflow, list] of [...byWorkflow].sort(([a], [b]) => byText(a, b))) {
    const newest = [...list].sort((a, b) => byText(b.at, a.at) || byText(b.id, a.id)).slice(0, 2)
    if (newest.length < 2 || !newest.every((run) => isRedConclusion(run.conclusion))) continue
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
  if (snapshot.unchecked.length > 0) found.push(uncheckedFinding(snapshot.unchecked))
  return found
}

function uncheckedFinding(unchecked: string[]): Finding {
  const names = [...unchecked].sort(byText)
  return {
    kind: 'migration_clash',
    subject: 'refs-unchecked',
    // no digits in the title: intake's fingerprint drops them, and the count moves from pass to pass
    title: `Self-watch: migration check skipped ${names.length} refs over its limit`,
    facts: ['refs over the comparison limit were not compared with origin/master'],
    // the count and the names move from pass to pass: context is never hashed
    context: [
      `${names.length} refs were not compared`,
      ...names.slice(0, MAX_LISTED).map((name) => `unchecked: ${name}`),
      'A clash on one of these refs goes unseen until the refs are fewer than the limit.',
    ],
    reproduce:
      'git for-each-ref refs/heads/ refs/remotes/origin/; git diff --name-only --diff-filter=A origin/master...<ref> -- apps/server/migrations/',
  }
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
      title: `Self-watch: ${wait.reason} wait overdue for ${spelled(wait.issue)}`,
      facts: [
        `${wait.issue} (${oneLine(wait.title, 200)}) waits for a ${wait.reason}, since v${wait.since} (${iso(wait.sinceAt)})`,
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

/** A lead whose session has been quiet longer than the steward's threshold (`idleLeadMs`; `idleBackgroundMs` when it waits on background work). */
export function idleFindings(
  leads: readonly IdleLead[],
  now: Date,
  thresholds: { idleLeadMs: number; idleBackgroundMs: number },
): Finding[] {
  const limit = (lead: IdleLead) => (lead.background ? thresholds.idleBackgroundMs : thresholds.idleLeadMs)
  return leads
    .filter((lead) => now.getTime() - lead.idleSince.getTime() > limit(lead))
    .map((lead) => ({
      kind: 'lead_idle' as const,
      subject: lead.lead,
      title: `Self-watch: lead ${spelled(lead.lead)} idle past the steward's threshold`,
      facts: [
        `${lead.issue} (${oneLine(lead.title, 200)}) is working, its lead ${lead.lead} reported nothing`,
        `idle since ${iso(lead.idleSince)}`,
        lead.background
          ? `threshold: ${Math.round(thresholds.idleBackgroundMs / 60_000)} min (FACTORY_STEWARD_IDLE_BACKGROUND_MS), background work was in flight when its turn ended`
          : `threshold: ${Math.round(thresholds.idleLeadMs / 60_000)} min (FACTORY_STEWARD_IDLE_MS)`,
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
      title: `Self-watch: regression of ${spelled(regression.issue)} after a ship of inert paths only`,
      facts: [
        `${regression.issue} (${oneLine(regression.title, 200)}) regressed: ${oneLine(regression.detail, 200)}`,
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

/**
 * `tick`: the leads' tick is a failure (`judgeTick`: its reasons start `no tick has succeeded` or `the last successful tick`);
 * `database`: anything else `healthOf` reports.
 */
export const heartbeatClass = (reason: string | null): 'tick' | 'database' =>
  reason !== null && (reason.startsWith('no tick has succeeded') || reason.startsWith('the last successful tick'))
    ? 'tick'
    : 'database'

/** A database miss is read again this many times, `DATABASE_RECHECK_GAP_MS` apart, before it counts. */
export const DATABASE_RECHECKS = 2
export const DATABASE_RECHECK_GAP_MS = 5_000

/**
 * The heartbeat the self-watch judges. One `SELECT 1` that misses its limit while a restart or a test storm loads the
 * host is not a database that does not answer (a deploy at load 50 filed one, #827), so a database-class miss is read
 * again after a pause and counts only if every read misses. A tick problem is judged by its own age and is never reread.
 */
export async function confirmedHeartbeat(
  read: () => Promise<HeartbeatFact>,
  pause: (ms: number) => Promise<void>,
): Promise<HeartbeatFact> {
  let beat = await read()
  for (let again = 0; again < DATABASE_RECHECKS && !beat.ok && heartbeatClass(beat.reason) === 'database'; again++) {
    await pause(DATABASE_RECHECK_GAP_MS)
    beat = await read()
  }
  return beat
}

export function heartbeatFindings(heartbeat: HeartbeatFact, now: Date): Finding[] {
  if (heartbeat.ok) return []
  const kind = heartbeatClass(heartbeat.reason)
  return [
    {
      kind: 'heartbeat_stale',
      subject: kind,
      title: `Self-watch: the heartbeat is stale: ${kind === 'tick' ? 'the leads tick has stopped' : 'the database does not answer'}`,
      // the class alone: the last tick's time moves with every restart and recovery, so it is never part of the evidence
      facts: [`heartbeat class: ${kind}`],
      context: [
        `tickAt: ${heartbeat.tickAt ?? 'never'}`,
        // the queue moves when this very signal is filed
        `queueMovedAt: ${heartbeat.queueMovedAt ?? 'never'}`,
        `Reason: ${oneLine(heartbeat.reason ?? 'none')}`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'curl the server GET /health; factory read loops',
    },
  ]
}

// ---- 7. process_growth, 8. swap_growth, 9. process_storm -------------------------------------------------------------------

/** A process that grew by more than this within `GROWTH_WINDOW_MS` is a runaway (the daemons of the 2026-11-13 panic grew by many GiB). */
export const GROWTH_MIB = 1024
export const GROWTH_WINDOW_MS = 60 * 60_000
/** A growth is judged on a process seen at least this long: a test step that starts and peaks within minutes is not a leak. */
const GROWTH_MIN_SPAN_MS = 30 * 60_000
/** A reading older than this is not the host as it is now: a process that ended, a host loop that stopped. */
const FRESH_MS = 3 * 60_000

/** Swap use that rose over this many minute samples, never falling, is a swap that grows. */
export const SWAP_RISE_MINUTES = 15
/** The rise over those minutes, in points of swap use, below which a flat reading is noise. */
const SWAP_MIN_RISE_PCT = 0.5
/** Two minute samples further apart than this are not consecutive. */
const MINUTE_GAP_MS = 90_000

/** The process count must stay over the cap this many samples in a row: one `top` reading can be a spike of a build. */
export const STORM_SAMPLES = 3
/** Until `tp-leads` brings its own cap, the host's process count past which the host is in a process storm. */
export const DEFAULT_PROCESS_CAP = 2500

/** Whether the newest minute sample is recent enough to say what the host is doing now. */
export const hostSampleIsFresh = (minutes: readonly HostMinute[], now: Date): boolean =>
  minutes.some((minute) => now.getTime() - minute.at.getTime() <= FRESH_MS)

const mib = (n: number): string => `${Math.round(n)} MiB`

/**
 * A process (by pid and program name) whose footprint rose by more than 1 GiB between the first and the last of its
 * samples in the last hour, seen over at least 30 minutes and still present. The evidence is the process and the limit; the
 * figures move every minute and are context, so the signal is filed once and repeats only after the growth has cleared.
 */
export function processGrowthFindings(samples: readonly ProcessMinute[], now: Date): Finding[] {
  const byProcess = new Map<string, ProcessMinute[]>()
  for (const sample of samples) {
    if (sample.at.getTime() < now.getTime() - GROWTH_WINDOW_MS) continue
    const key = `${sample.name}:${sample.pid}`
    byProcess.set(key, [...(byProcess.get(key) ?? []), sample])
  }
  const found: Finding[] = []
  for (const [subject, list] of [...byProcess].sort(([a], [b]) => byText(a, b))) {
    const ordered = [...list].sort((a, b) => a.at.getTime() - b.at.getTime())
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    if (!first || !last || first === last) continue
    if (now.getTime() - last.at.getTime() > FRESH_MS) continue
    if (last.at.getTime() - first.at.getTime() < GROWTH_MIN_SPAN_MS) continue
    const grown = last.footprintMib - first.footprintMib
    if (grown <= GROWTH_MIB) continue
    found.push({
      kind: 'process_growth',
      subject,
      title: `Self-watch: process ${oneLine(first.name, 60)} grew by more than one GiB in an hour`,
      facts: [
        `${first.name} (pid ${first.pid}, class ${first.class}) grew by more than ${GROWTH_MIB} MiB within one hour`,
      ],
      context: [
        `From ${mib(first.footprintMib)} at ${iso(first.at)} to ${mib(last.footprintMib)} at ${iso(last.at)}: ${mib(grown)}`,
        `Now: ${iso(now)}`,
      ],
      reproduce: `factory read host (the host loop's notable processes); ps -o pid,rss,command -p ${first.pid}`,
    })
  }
  return found
}

/**
 * Swap use that did not fall and ended higher over the last 15 minutes in a row: 16 consecutive minute samples, every one
 * read, the newest not older than 3 minutes. Cleared at the first minute it falls or a reading is missing.
 */
export function swapGrowthFindings(minutes: readonly HostMinute[], now: Date): Finding[] {
  const ordered = [...minutes].sort((a, b) => a.at.getTime() - b.at.getTime())
  const run: { at: Date; pct: number }[] = []
  for (const minute of ordered) {
    const previous = run[run.length - 1]
    const consecutive = previous !== undefined && minute.at.getTime() - previous.at.getTime() <= MINUTE_GAP_MS
    if (minute.swapUsedPct === null) {
      run.length = 0
      continue
    }
    if (previous !== undefined && (!consecutive || minute.swapUsedPct < previous.pct)) run.length = 0
    run.push({ at: minute.at, pct: minute.swapUsedPct })
  }
  const last = run[run.length - 1]
  if (!last || now.getTime() - last.at.getTime() > FRESH_MS || run.length < SWAP_RISE_MINUTES + 1) return []
  const start = run[run.length - 1 - SWAP_RISE_MINUTES]
  if (!start || last.pct - start.pct < SWAP_MIN_RISE_PCT) return []
  return [
    {
      kind: 'swap_growth',
      subject: 'host',
      title: 'Self-watch: swap use of the host has grown for fifteen minutes in a row',
      facts: [`swap use never fell and rose over ${SWAP_RISE_MINUTES} minute samples in a row`],
      context: [
        `From ${start.pct.toFixed(1)}% at ${iso(start.at)} to ${last.pct.toFixed(1)}% at ${iso(last.at)}`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'factory read host; factory read throughput (the host signals and the notable processes)',
    },
  ]
}

/** The host's process count over `cap` for the last 3 samples, the newest not older than 3 minutes. */
export function processStormFindings(minutes: readonly HostMinute[], cap: number, now: Date): Finding[] {
  const ordered = [...minutes].sort((a, b) => a.at.getTime() - b.at.getTime())
  const tail = ordered.slice(-STORM_SAMPLES)
  const last = tail[tail.length - 1]
  if (!last || tail.length < STORM_SAMPLES || now.getTime() - last.at.getTime() > FRESH_MS) return []
  if (!tail.every((minute) => minute.processes !== null && minute.processes > cap)) return []
  return [
    {
      kind: 'process_storm',
      subject: 'host',
      title: 'Self-watch: the process count of the host is over its cap',
      facts: [`the process count stayed over the cap of ${cap} for ${STORM_SAMPLES} samples in a row`],
      context: [`Now ${last.processes} processes at ${iso(last.at)}`, `Now: ${iso(now)}`],
      reproduce: 'factory read host; ps -A | wc -l',
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
