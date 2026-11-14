import type { SQL } from 'bun'
import * as z from 'zod'
import type { LeadSplit, ThroughputModel } from '@software-factory/contract'

/** The Issues of the lead part's list. */
const TOP_ISSUES = 50

const num = z.coerce.number()
const nullNum = z.coerce.number().nullable()

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals

/** The repo a step belongs to: the directory name of the project's checkout (`step_costs.repo` is a path). */
const REPO_OF_STEP = `regexp_replace(rtrim(repo, '/'), '^.*/', '')`

/** The tier of a step: `<project> check-fast` is `fast`, `<project> check` is `full`, any other step its own last word. */
const TIER_OF_STEP = `CASE regexp_replace(name, '^.* ', '')
  WHEN 'check-fast' THEN 'fast' WHEN 'check' THEN 'full' ELSE regexp_replace(name, '^.* ', '') END`

const IssueRow = z.object({
  issue_id: z.string(),
  repo: z.string(),
  closed_at: z.coerce.date(),
  wall: num,
  owner: num,
  step: num,
  slot: num,
  lock: num,
  ci: num,
  turn: num,
  idle: num,
})

const ProjectStepRow = z.object({
  repo: z.string(),
  steps: num,
  minutes: num,
  wait_minutes: num,
  wait_p50: nullNum,
  wait_p90: nullNum,
  peak: nullNum,
  failed_steps: num,
  failed_minutes: num,
})
const TierRow = z.object({ repo: z.string(), tier: z.string(), runs: num, p50: num, p90: num, total: num })
const CiRow = z.object({
  repo: z.string(),
  runs: num,
  minutes: num,
  queue_minutes: num,
  p50: nullNum,
  p90: nullNum,
  failed_runs: num,
  failed_minutes: num,
})
const LockRow = z.object({ repo: z.string(), windows: num, wait_minutes: num, hold_minutes: num })
const ClosedRow = z.object({ repo: z.string(), closed: num })

const zeroSplit = (): LeadSplit => ({
  ownerSeconds: 0,
  stepSeconds: 0,
  slotWaitSeconds: 0,
  mergeLockSeconds: 0,
  ciSeconds: 0,
  turnSeconds: 0,
  idleSeconds: 0,
})

const addSplit = (into: LeadSplit, add: LeadSplit): void => {
  into.ownerSeconds += add.ownerSeconds
  into.stepSeconds += add.stepSeconds
  into.slotWaitSeconds += add.slotWaitSeconds
  into.mergeLockSeconds += add.mergeLockSeconds
  into.ciSeconds += add.ciSeconds
  into.turnSeconds += add.turnSeconds
  into.idleSeconds += add.idleSeconds
}

const roundSplit = (split: LeadSplit): LeadSplit => ({
  ownerSeconds: round(split.ownerSeconds, 1),
  stepSeconds: round(split.stepSeconds, 1),
  slotWaitSeconds: round(split.slotWaitSeconds, 1),
  mergeLockSeconds: round(split.mergeLockSeconds, 1),
  ciSeconds: round(split.ciSeconds, 1),
  turnSeconds: round(split.turnSeconds, 1),
  idleSeconds: round(split.idleSeconds, 1),
})

/** The seconds a multirange covers. */
const SECONDS = (column: string) =>
  `(SELECT coalesce(sum(extract(epoch FROM upper(r) - lower(r))), 0) FROM unnest(${column}) AS r)`

/**
 * Splits the wall time of every Issue closed in `[from, to)` into the places it went. Each place is built as a set of
 * time ranges inside the wall (a multirange), and takes only the time the places before it did not, in this order: the
 * owner, a step, a slot wait, the merge lock, CI, a turn; what none of them covers is idle. The places are therefore
 * exclusive and add up to the wall. The wall is the time from the start of the first lead after the Issue's previous
 * close to its close.
 */
async function readLeadSplits(tx: SQL, from: Date, to: Date) {
  const rows: unknown[] = await tx`
    WITH closings AS (
      SELECT issue_id, at AS closed_at, lag(at) OVER (PARTITION BY issue_id ORDER BY version) AS prev_closed
      FROM factory.issue_events WHERE result = 'applied' AND to_state = 'closed'),
    walls AS (
      SELECT c.issue_id, i.repo, c.closed_at, tstzrange(min(a.started_at), c.closed_at, '[)') AS wall
      FROM closings c
        JOIN factory.issues i ON i.id = c.issue_id
        JOIN factory.lead_attempts a ON a.issue_id = c.issue_id AND a.started_at IS NOT NULL AND a.started_at < c.closed_at
          AND (c.prev_closed IS NULL OR a.started_at > c.prev_closed)
      WHERE c.closed_at >= ${from} AND c.closed_at < ${to}
      GROUP BY c.issue_id, i.repo, c.closed_at),
    states AS (
      SELECT issue_id, at AS s, lead(at) OVER (PARTITION BY issue_id ORDER BY version) AS e, to_state, wait->>'reason' AS reason
      FROM factory.issue_events WHERE result = 'applied'),
    owner AS (
      SELECT w.issue_id, w.closed_at, range_agg(tstzrange(s.s, greatest(s.s, s.e), '[)') * w.wall) AS mr
      FROM walls w JOIN states s ON s.issue_id = w.issue_id AND s.to_state = 'waiting' AND s.e IS NOT NULL
        AND s.reason IN ('decision', 'review', 'errand', 'external')
      GROUP BY w.issue_id, w.closed_at),
    step_issue AS (
      SELECT s.at, s.duration_ms, s.wait_ms, coalesce(
        (SELECT a.issue_id FROM factory.lead_attempts a
         WHERE s.cwd IS NOT NULL AND a.worktree_path IS NOT NULL
           AND (s.cwd = a.worktree_path OR left(s.cwd, length(a.worktree_path) + 1) = a.worktree_path || '/')
         ORDER BY a.attempt DESC LIMIT 1),
        CASE WHEN s.name ~ '^factory-[0-9]+-[0-9]+ ' THEN 'issue_' || substring(s.name FROM '^factory-([0-9]+)-') END) AS issue_id
      FROM factory.step_costs s),
    stepped AS (
      SELECT w.issue_id, w.closed_at,
        range_agg(tstzrange(s.at - s.duration_ms * interval '1 millisecond', s.at, '[)') * w.wall) AS step_mr,
        range_agg(tstzrange(s.at - (s.duration_ms + s.wait_ms) * interval '1 millisecond',
                            s.at - s.duration_ms * interval '1 millisecond', '[)') * w.wall) AS slot_mr
      FROM walls w JOIN step_issue s ON s.issue_id = w.issue_id
      GROUP BY w.issue_id, w.closed_at),
    lock_issue AS (
      SELECT m.requested_at, coalesce(m.acquired_at, m.released_at) AS got, coalesce(
        (SELECT a.issue_id FROM factory.lead_attempts a
         WHERE m.cwd IS NOT NULL AND a.worktree_path IS NOT NULL
           AND (m.cwd = a.worktree_path OR left(m.cwd, length(a.worktree_path) + 1) = a.worktree_path || '/')
         ORDER BY a.attempt DESC LIMIT 1), '') AS issue_id
      FROM factory.merge_windows m),
    locked AS (
      SELECT w.issue_id, w.closed_at, range_agg(tstzrange(m.requested_at, m.got, '[)') * w.wall) AS mr
      FROM walls w JOIN lock_issue m ON m.issue_id = w.issue_id
      GROUP BY w.issue_id, w.closed_at),
    ci AS (
      SELECT w.issue_id, w.closed_at, range_agg(tstzrange(r.queued_at, r.finished_at, '[)') * w.wall) AS mr
      FROM walls w
        JOIN factory.lead_attempts a ON a.issue_id = w.issue_id
        JOIN factory.ci_runs r ON r.repo = w.repo AND r.head_branch = a.branch
      GROUP BY w.issue_id, w.closed_at),
    hook AS (
      SELECT issue_id, session, kind, at, lead(at) OVER (PARTITION BY session ORDER BY at, seq) AS e
      FROM factory.lead_hook_events
      WHERE kind IN ('turn_started', 'turn_ended', 'api_error', 'session_ended', 'pane_gone')
         OR (kind = 'session_started' AND coalesce(payload->>'source', '') <> 'compact')),
    turned AS (
      SELECT w.issue_id, w.closed_at,
        range_agg(tstzrange(h.at, coalesce(h.e, upper(w.wall)), '[)') * w.wall) AS mr
      FROM walls w JOIN hook h ON h.issue_id = w.issue_id AND h.kind = 'turn_started'
      GROUP BY w.issue_id, w.closed_at),
    sets AS (
      SELECT w.issue_id, w.repo, w.closed_at, w.wall,
        coalesce(o.mr, '{}'::tstzmultirange) AS o, coalesce(s.step_mr, '{}'::tstzmultirange) AS st,
        coalesce(s.slot_mr, '{}'::tstzmultirange) AS sl, coalesce(l.mr, '{}'::tstzmultirange) AS lk,
        coalesce(c.mr, '{}'::tstzmultirange) AS ci, coalesce(t.mr, '{}'::tstzmultirange) AS tu
      FROM walls w
        LEFT JOIN owner o USING (issue_id, closed_at) LEFT JOIN stepped s USING (issue_id, closed_at)
        LEFT JOIN locked l USING (issue_id, closed_at) LEFT JOIN ci c USING (issue_id, closed_at)
        LEFT JOIN turned t USING (issue_id, closed_at)),
    parts AS (
      SELECT issue_id, repo, closed_at, wall, o,
        st - o AS st, sl - (o + st) AS sl, lk - (o + st + sl) AS lk, ci - (o + st + sl + lk) AS ci,
        tu - (o + st + sl + lk + ci) AS tu,
        tstzmultirange(wall) - (o + st + sl + lk + ci + tu) AS idle
      FROM sets)
    SELECT issue_id, repo, closed_at, ${tx.unsafe(SECONDS('tstzmultirange(wall)'))}::float8 AS wall,
      ${tx.unsafe(SECONDS('o'))}::float8 AS owner, ${tx.unsafe(SECONDS('st'))}::float8 AS step,
      ${tx.unsafe(SECONDS('sl'))}::float8 AS slot, ${tx.unsafe(SECONDS('lk'))}::float8 AS lock,
      ${tx.unsafe(SECONDS('ci'))}::float8 AS ci, ${tx.unsafe(SECONDS('tu'))}::float8 AS turn,
      ${tx.unsafe(SECONDS('idle'))}::float8 AS idle
    FROM parts ORDER BY closed_at, issue_id`
  return rows.map((raw) => IssueRow.parse(raw))
}

/** The Issue's number, for sorting: `issue_12` is 12. */
const numberOf = (issue: string): number => Number(issue.slice('issue_'.length))

type Lead = ThroughputModel['lead']
type Project = ThroughputModel['project']

/**
 * The lead part and the project scorecards over `[from, to)`: every figure is SQL over the stored rows (`issue_events`,
 * `lead_attempts`, `lead_hook_events`, `step_costs`, `merge_windows`, `ci_runs`); only the sums over Issues and the
 * rounding happen here.
 */
export async function readAccount(tx: SQL, from: Date, to: Date): Promise<{ lead: Lead; project: Project }> {
  const issues = await readLeadSplits(tx, from, to)
  const perIssue = issues.map((row) => ({
    issue: row.issue_id,
    repo: row.repo,
    closedAt: row.closed_at.toISOString(),
    wallSeconds: row.wall,
    split: {
      ownerSeconds: row.owner,
      stepSeconds: row.step,
      slotWaitSeconds: row.slot,
      mergeLockSeconds: row.lock,
      ciSeconds: row.ci,
      turnSeconds: row.turn,
      idleSeconds: row.idle,
    } satisfies LeadSplit,
  }))

  const total = zeroSplit()
  let wall = 0
  const byRepo = new Map<string, { closed: number; wall: number; split: LeadSplit }>()
  for (const issue of perIssue) {
    addSplit(total, issue.split)
    wall += issue.wallSeconds
    const own = byRepo.get(issue.repo) ?? { closed: 0, wall: 0, split: zeroSplit() }
    own.closed++
    own.wall += issue.wallSeconds
    addSplit(own.split, issue.split)
    byRepo.set(issue.repo, own)
  }

  const lead: Lead = {
    closed: perIssue.length,
    wallSeconds: round(wall, 1),
    split: roundSplit(total),
    issues: [...perIssue]
      .sort((a, b) => b.wallSeconds - a.wallSeconds || numberOf(a.issue) - numberOf(b.issue))
      .slice(0, TOP_ISSUES)
      .map((i) => ({ ...i, wallSeconds: round(i.wallSeconds, 1), split: roundSplit(i.split) })),
  }

  const closedRows: unknown[] = await tx`
    SELECT i.repo, count(DISTINCT e.issue_id) AS closed
    FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.result = 'applied' AND e.to_state = 'closed' AND e.at >= ${from} AND e.at < ${to} GROUP BY i.repo`
  const stepRows: unknown[] = await tx`
    SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, count(*) AS steps, sum(duration_ms)::float8 / 60000 AS minutes,
      sum(wait_ms)::float8 / 60000 AS wait_minutes,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms)::float8 AS wait_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_ms)::float8 AS wait_p90,
      max(peak_rss_mib) AS peak,
      count(*) FILTER (WHERE exit_code IS NOT NULL AND exit_code <> 0) AS failed_steps,
      coalesce(sum(duration_ms) FILTER (WHERE exit_code IS NOT NULL AND exit_code <> 0), 0)::float8 / 60000 AS failed_minutes
    FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY 1`
  const tierRows: unknown[] = await tx`
    SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, ${tx.unsafe(TIER_OF_STEP)} AS tier, count(*) AS runs,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p90, sum(duration_ms)::float8 AS total
    FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY 1, 2`
  const ciRows: unknown[] = await tx`
    SELECT repo, count(*) AS runs, sum(extract(epoch FROM finished_at - started_at))::float8 / 60 AS minutes,
      sum(extract(epoch FROM started_at - queued_at))::float8 / 60 AS queue_minutes,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) / 60)::float8 AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) / 60)::float8 AS p90,
      count(*) FILTER (WHERE conclusion <> 'success') AS failed_runs,
      coalesce(sum(extract(epoch FROM finished_at - started_at)) FILTER (WHERE conclusion <> 'success'), 0)::float8 / 60 AS failed_minutes
    FROM factory.ci_runs
    WHERE conclusion IN ('success', 'failure', 'timed_out') AND finished_at >= ${from} AND finished_at < ${to} GROUP BY repo`
  const lockRows: unknown[] = await tx`
    SELECT project AS repo, count(*) AS windows,
      coalesce(sum(extract(epoch FROM coalesce(acquired_at, released_at) - requested_at)), 0)::float8 / 60 AS wait_minutes,
      coalesce(sum(extract(epoch FROM released_at - acquired_at)), 0)::float8 / 60 AS hold_minutes
    FROM factory.merge_windows WHERE released_at >= ${from} AND released_at < ${to} GROUP BY project`

  const closed = new Map(closedRows.map((raw) => ClosedRow.parse(raw)).map((r) => [r.repo, r.closed]))
  const steps = new Map(stepRows.map((raw) => ProjectStepRow.parse(raw)).map((r) => [r.repo, r]))
  const ci = new Map(ciRows.map((raw) => CiRow.parse(raw)).map((r) => [r.repo, r]))
  const locks = new Map(lockRows.map((raw) => LockRow.parse(raw)).map((r) => [r.repo, r]))
  const tiers = new Map<string, z.infer<typeof TierRow>[]>()
  for (const raw of tierRows) {
    const row = TierRow.parse(raw)
    tiers.set(row.repo, [...(tiers.get(row.repo) ?? []), row])
  }

  const repos = [...new Set([...closed.keys(), ...steps.keys(), ...ci.keys(), ...locks.keys(), ...byRepo.keys()])]
  const project: Project = repos
    .map((repo) => {
      const s = steps.get(repo)
      const c = ci.get(repo)
      const m = locks.get(repo)
      const own = byRepo.get(repo)
      const closedIssues = closed.get(repo) ?? 0
      const localMinutes = s?.minutes ?? 0
      const ciMinutes = c?.minutes ?? 0
      return {
        repo,
        closedIssues,
        slot: {
          steps: s?.steps ?? 0,
          minutes: round(localMinutes, 2),
          minutesPerClosedIssue: closedIssues > 0 && s ? round(localMinutes / closedIssues, 2) : null,
          waitMinutes: round(s?.wait_minutes ?? 0, 2),
          waitP50Ms: s?.wait_p50 ?? null,
          waitP90Ms: s?.wait_p90 ?? null,
          peakMib: s?.peak ?? null,
          failedSteps: s?.failed_steps ?? 0,
          failedMinutes: round(s?.failed_minutes ?? 0, 2),
        },
        check: {
          tiers: [...(tiers.get(repo) ?? [])]
            .sort((a, b) => b.total - a.total || a.tier.localeCompare(b.tier))
            .map((t) => ({ tier: t.tier, runs: t.runs, p50Ms: t.p50, p90Ms: t.p90 })),
        },
        ci: {
          runs: c?.runs ?? 0,
          minutes: round(ciMinutes, 2),
          queueMinutes: round(c?.queue_minutes ?? 0, 2),
          p50Minutes: c?.p50 ?? null,
          p90Minutes: c?.p90 ?? null,
          failedRuns: c?.failed_runs ?? 0,
          failedMinutes: round(c?.failed_minutes ?? 0, 2),
        },
        localToCi: {
          localMinutes: round(localMinutes, 2),
          ciMinutes: round(ciMinutes, 2),
          localShare: localMinutes + ciMinutes > 0 ? round(localMinutes / (localMinutes + ciMinutes), 4) : null,
        },
        mergeLock: {
          windows: m?.windows ?? 0,
          waitMinutes: round(m?.wait_minutes ?? 0, 2),
          holdMinutes: round(m?.hold_minutes ?? 0, 2),
        },
        leadTime: {
          closed: own?.closed ?? 0,
          wallSeconds: round(own?.wall ?? 0, 1),
          split: roundSplit(own?.split ?? zeroSplit()),
        },
      }
    })
    .sort((a, b) => b.slot.minutes - a.slot.minutes || a.repo.localeCompare(b.repo))

  return { lead, project }
}
