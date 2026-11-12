import type { SQL } from 'bun'
import * as z from 'zod'
import type { RetroBuild, RetroBuildRepo, RetroCapacityFigure } from '@software-factory/contract'
import type { CiRunTime, CiTimes } from '../domains/loops/ports.ts'
import { boundedRead } from './bounded.ts'
import { percentile, windowOf } from './stats.ts'

/** Steps listed per repo. */
export const SLOWEST_STEPS = 5

/** Repos whose CI is read at once. */
const CI_CONCURRENCY = 8

/** The whole CI read ends here: a repo not answered by then is unreadable (the CLI waits 120 s for the bundle). */
export const CI_READ_DEADLINE_MS = 80_000

const MINUTE_MS = 60_000

const Count = z.object({ repo: z.string(), closed: z.coerce.number().int() })
const Totals = z.object({
  repo: z.string(),
  runs: z.coerce.number().int(),
  total_ms: z.coerce.number(),
  wait_ms: z.coerce.number(),
  wait_p90: z.coerce.number().nullable(),
})
const Step = z.object({
  repo: z.string(),
  name: z.string(),
  runs: z.coerce.number().int(),
  median: z.coerce.number(),
  p90: z.coerce.number(),
  total_ms: z.coerce.number(),
})

/** The repo a step cost belongs to: the directory name of the project's checkout. */
const REPO_OF_STEP = `regexp_replace(rtrim(repo, '/'), '^.*/', '')`

interface CheckRead {
  closed: Map<string, number>
  totals: Map<string, z.infer<typeof Totals>>
  steps: Map<string, RetroBuildRepo['check']['slowestSteps']>
}

async function readChecks(sql: SQL, from: Date, to: Date): Promise<CheckRead> {
  return boundedRead(sql, 10_000, async (tx) => {
    const closedRows: unknown[] = await tx`
      SELECT i.repo, count(DISTINCT e.issue_id) AS closed
      FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
      WHERE e.result = 'applied' AND e.to_state = 'closed' AND e.at >= ${from} AND e.at < ${to} GROUP BY i.repo`
    const totalRows: unknown[] = await tx`
      SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, count(*) AS runs, sum(duration_ms)::float8 AS total_ms,
        sum(wait_ms)::float8 AS wait_ms,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_ms)::float8 AS wait_p90
      FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY 1`
    // a lead's steps carry its worktree's name in front (`factory-841-1 layout`): the step is the rest
    const stepRows: unknown[] = await tx`
      SELECT repo, name, runs, median, p90, total_ms FROM (
        SELECT repo, name, runs, median, p90, total_ms,
          row_number() OVER (PARTITION BY repo ORDER BY total_ms DESC, name) AS place
        FROM (
          SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, regexp_replace(name, '^factory-[0-9]+-[0-9]+ ', '') AS name,
            count(*) AS runs, percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS median,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p90,
            sum(duration_ms)::float8 AS total_ms
          FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY 1, 2
        ) s
      ) ranked WHERE place <= ${SLOWEST_STEPS} ORDER BY repo, place`
    const steps = new Map<string, RetroBuildRepo['check']['slowestSteps']>()
    for (const raw of stepRows) {
      const row = Step.parse(raw)
      steps.set(row.repo, [
        ...(steps.get(row.repo) ?? []),
        {
          name: row.name,
          runs: row.runs,
          medianMs: row.median,
          p90Ms: row.p90,
          totalMinutes: row.total_ms / MINUTE_MS,
        },
      ])
    }
    return {
      closed: new Map(closedRows.map((raw) => Count.parse(raw)).map((r) => [r.repo, r.closed])),
      totals: new Map(totalRows.map((raw) => Totals.parse(raw)).map((r) => [r.repo, r])),
      steps,
    }
  })
}

const kindOf = (runs: readonly CiRunTime[]) => {
  if (runs.length === 0) return null
  const minutes = runs.map((r) => r.minutes)
  return { runs: runs.length, p50Minutes: percentile(minutes, 0.5) ?? 0, p90Minutes: percentile(minutes, 0.9) ?? 0 }
}

const ciOf = ({
  runs,
  truncated,
}: {
  runs: readonly CiRunTime[]
  truncated: boolean
}): NonNullable<RetroBuildRepo['ci']> => ({
  defaultBranch: kindOf(runs.filter((r) => r.kind === 'default')),
  pullRequest: kindOf(runs.filter((r) => r.kind === 'pr')),
  totalMinutes: runs.reduce((sum, r) => sum + r.minutes, 0),
  truncated,
  flakyShare: runs.length === 0 ? null : runs.filter((r) => r.flaky).length / runs.length,
})

/** At most `limit` of the tasks at once, in order of the list. */
async function inBatches<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = []
  for (let i = 0; i < items.length; i += limit) done.push(...(await Promise.all(items.slice(i, i + limit).map(task))))
  return done
}

/**
 * What building costs per repo over the last `days` days: the local check minutes from the test-slot step costs (runs x
 * duration, per closed Issue, per named step, the wait for a slot) and, when `ciTimes` is given, the duration of the
 * repo's finished CI runs on the default branch and on pull request heads. A repo is in the answer when an Issue closed
 * in it or a step ran in it. A repo whose CI cannot be read is named under `unreadable` and keeps its check figures.
 */
export async function readRetroBuild(
  sql: SQL,
  options: { now: Date; days: number; ciTimes?: CiTimes; ciDeadlineMs?: number },
): Promise<RetroBuild> {
  const w = windowOf(options.now, options.days)
  const checks = await readChecks(sql, w.from, w.to)
  const names = [...new Set([...checks.closed.keys(), ...checks.totals.keys()])].sort()

  const unreadable: RetroBuild['unreadable'] = []
  const allRuns: CiRunTime[] = []
  const readOf = new Map<string, { runs: CiRunTime[]; truncated: boolean }>()
  const { ciTimes } = options
  if (ciTimes) {
    const deadline = Date.now() + (options.ciDeadlineMs ?? CI_READ_DEADLINE_MS)
    // the repos with the most work first, so a read that runs out of time loses the quietest ones
    const busiest = [...names].sort(
      (a, b) =>
        (checks.totals.get(b)?.total_ms ?? 0) - (checks.totals.get(a)?.total_ms ?? 0) ||
        (checks.closed.get(b) ?? 0) - (checks.closed.get(a) ?? 0) ||
        a.localeCompare(b),
    )
    const answers = await inBatches(busiest, CI_CONCURRENCY, async (repo) => {
      const left = deadline - Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<Awaited<ReturnType<CiTimes>>>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: { kind: 'timeout', detail: 'the CI read ran out of time' } }),
          Math.max(left, 0),
        )
      })
      try {
        return [repo, await Promise.race([ciTimes(repo, w.from), late])] as const
      } catch (error) {
        return [
          repo,
          { ok: false, error: { kind: 'unreadable', detail: error instanceof Error ? error.message : 'error' } },
        ] as const
      } finally {
        clearTimeout(timer)
      }
    })
    for (const [repo, answer] of answers) {
      if (!answer.ok) {
        unreadable.push({ repo, reason: answer.error.detail })
        continue
      }
      readOf.set(repo, answer.value)
      allRuns.push(...answer.value.runs)
    }
    unreadable.sort((a, b) => a.repo.localeCompare(b.repo))
  }

  const repos: RetroBuildRepo[] = names.map((repo) => {
    const closedIssues = checks.closed.get(repo) ?? 0
    const total = checks.totals.get(repo)
    const runs = total?.runs ?? 0
    const totalMinutes = (total?.total_ms ?? 0) / MINUTE_MS
    const read = readOf.get(repo)
    const ci = read ? ciOf(read) : null
    const measured = runs > 0 || (ci?.totalMinutes ?? 0) > 0
    return {
      repo,
      closedIssues,
      check: {
        runs,
        totalMinutes,
        runsPerIssue: closedIssues > 0 ? runs / closedIssues : null,
        minutesPerIssue: closedIssues > 0 ? totalMinutes / closedIssues : null,
        waitMinutes: (total?.wait_ms ?? 0) / MINUTE_MS,
        waitP90Ms: total?.wait_p90 ?? null,
        slowestSteps: checks.steps.get(repo) ?? [],
      },
      ci,
      minutesPerIssue: closedIssues > 0 && measured ? (totalMinutes + (ci?.totalMinutes ?? 0)) / closedIssues : null,
    }
  })
  repos.sort(
    (a, b) =>
      (b.minutesPerIssue ?? -1) - (a.minutesPerIssue ?? -1) ||
      b.check.totalMinutes - a.check.totalMinutes ||
      a.repo.localeCompare(b.repo),
  )

  const closedTotal = repos.reduce((sum, r) => sum + r.closedIssues, 0)
  const checkRuns = repos.reduce((sum, r) => sum + r.check.runs, 0)
  const checkMinutes = repos.reduce((sum, r) => sum + r.check.totalMinutes, 0)
  const figures: RetroCapacityFigure[] = [
    {
      key: 'check_minutes_per_issue',
      label: 'Local check minutes per closed Issue',
      value: closedTotal > 0 && checkRuns > 0 ? checkMinutes / closedTotal : null,
      unit: 'minutes',
    },
    {
      key: 'ci_p50_minutes',
      label: 'CI run duration, median',
      value: percentile(
        allRuns.map((r) => r.minutes),
        0.5,
      ),
      unit: 'minutes',
    },
  ]
  return { repos, unreadable, figures }
}
