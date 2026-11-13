import type { SQL } from 'bun'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * What the capacity loop leaves behind, for Improve's Capacity section: host minutes with capacity facts (older than the
 * 24 hours `seedHost` fills, so no minute is shared), test-slot steps, lead samples of two repos and the reaper's rows,
 * all inside the 7-day window. Over the ceiling: 2 minutes. Idle seat-hours with work queued: 120 seat-minutes, 2 hours.
 * Slot wait over 6 steps: median 2 s, 90th percentile 55 s. The reaper ended 3 processes; one more row was a dry decision.
 */
export async function seedCapacity(sql: SQL, now = Date.now()): Promise<void> {
  const minute = (hoursAgo: number, plus = 0) => new Date(now - hoursAgo * HOUR + plus * MINUTE)
  const host: Array<[Date, number | null, number | null, number | null, number | null]> = [
    [minute(26), 9, 1, 2, 3], // over; 2 idle seats
    [minute(26, 1), 9, 2, 1, 3], // over; 1 idle seat
    [minute(26, 2), 3, 3, 1, 3], // seats all held
    [minute(26, 3), 3, 0, 0, 4], // nothing queued
    [minute(26, 4), null, null, null, null], // a minute that could not be read
    ...Array.from({ length: 39 }, (_, i): [Date, number | null, number | null, number | null, number | null] => [
      minute(30, i),
      3,
      1,
      2,
      4,
    ]), // 3 idle seats each
  ]
  for (const [at, load, leads, queued, seats] of host)
    await sql`INSERT INTO factory.host_samples (at, load, leads, queued, seats, load_ceiling)
      VALUES (${at}, ${load}, ${leads}, ${queued}, ${seats}, ${load === null ? null : 8})`

  const steps: Array<[number, string, number, number, number]> = [
    [40, 'software-factory check', 2500, 600_000, 1000],
    [38, 'software-factory check', 3100, 650_000, 20_000],
    [36, 'software-factory check', 2800, 620_000, 90_000],
    [34, 'software-factory test', 900, 90_000, 500],
    [32, 'software-factory test', 1100, 110_000, 700],
    [30, 'software-factory e2e', 1800, 300_000, 3000],
  ]
  for (const [hoursAgo, name, peak, duration, wait] of steps)
    await sql`INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, duration_ms, wait_ms)
      VALUES (${minute(hoursAgo)}, ${name}, 'argo', ${peak}, ${duration}, ${wait})`

  const leads: Array<[string, number, number]> = [
    ['argo', 1, 1500],
    ['argo', 2, 2200],
    ['argo', 3, 1800],
    ['zeta', 1, 700],
    ['zeta', 2, 900],
  ]
  for (const [repo, attempt, peak] of leads)
    for (let m = 0; m < 3; m++)
      await sql`INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, footprint_mib, procs)
        VALUES (${minute(60 - attempt * 5 - (repo === 'zeta' ? 20 : 0), m)}, ${`/work/${repo}-${attempt}`}, ${repo}, ${attempt}, 1,
          ${Math.round((peak * (m + 1)) / 3)}, ${repo === 'argo' ? Math.round(((peak * (m + 1)) / 3) * 0.6) : null}, 4)`

  const reaped: Array<[number, number, string, string, string]> = [
    [20, 501, 'node', 'SIGTERM', 'session'],
    [19, 502, 'bun', 'SIGKILL', 'worktree'],
    [18, 503, 'claude', 'SIGTERM', 'session'],
    [17, 504, 'node', 'dry', 'session'],
  ]
  for (const [hoursAgo, pid, comm, signal, reason] of reaped)
    await sql`INSERT INTO factory.reaped_processes (at, pid, session, worktree, comm, signal, reason, age_s)
      VALUES (${minute(hoursAgo)}, ${pid}, ${`lead-${pid}-1`}, '/work/gone', ${comm}, ${signal}, ${reason}, 900)`
}
