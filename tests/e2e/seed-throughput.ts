import type { SQL } from 'bun'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * What the throughput page reads besides the host curve `seedHost` fills and the steps `seedCapacity` leaves: the memory
 * pressure of the last 24 hours (normal, a warning spell of 40 minutes, a critical one of 10), per-minute class rows of
 * 60 minutes four hours back (leads and steps of two repos, two tenants, the system and the owner), the notable
 * processes of those minutes (one that grew), and one finding per status the loop ends a finding in.
 */
export async function seedThroughput(sql: SQL, now = Date.now()): Promise<void> {
  const ago = (minutes: number) => new Date(now - minutes * MINUTE)

  // the pressure of the host minutes `seedHost` wrote (every 5th minute): normal, a warning spell, a critical one
  await sql`UPDATE factory.host_samples SET pressure_level = 1 WHERE at > ${ago(24 * 60)} AND pressure_level IS NULL AND load IS NOT NULL`
  await sql`UPDATE factory.host_samples SET pressure_level = 2 WHERE at BETWEEN ${ago(7 * 60 + 40)} AND ${ago(7 * 60)}`
  await sql`UPDATE factory.host_samples SET pressure_level = 4 WHERE at BETWEEN ${ago(7 * 60 + 10)} AND ${ago(7 * 60 + 1)}`

  for (let m = 0; m < 60; m++) {
    const at = ago(4 * 60 - m)
    const swing = 1 + 0.15 * Math.sin(m / 6)
    const rows: Array<[string, string | null, string | null, number, number, number]> = [
      ['lead', 'argo', null, 3200 * swing, 4200, 4],
      ['lead', 'zeta', null, 1800 * swing, 2500, 3],
      ['step', 'argo', null, (m % 20 < 10 ? 5200 : 600) * swing, 11_000, 14],
      ['step', 'zeta', null, 700 * swing, 900, 3],
      ['tenant', null, 'svc.dns', 900, 40, 2],
      ['tenant', null, 'vm:build', 6400 * swing, 5200, 9],
      ['system', null, null, 9100, 1800, 310],
      ['owner', null, null, 2400 * swing, 1600, 22],
      ['factory', null, null, 850, 600, 6],
      ['other', null, null, 300, 80, 12],
    ]
    for (const [cls, repo, tenant, footprint, cpu, procs] of rows)
      await sql`INSERT INTO factory.host_class_samples (at, class, repo, tenant, footprint_mib, cpu_ms, procs)
        VALUES (${at}, ${cls}, ${repo}, ${tenant}, ${Math.round(footprint)}, ${cpu}, ${procs})`
    if (m % 10 === 0) {
      const process: Array<[number, string, string, string | null, string | null, number, string, number | null]> = [
        [9001, 'bun', 'step', 'argo', null, 5200, 'top', null],
        [9002, 'node', 'lead', 'argo', null, 1500 + m * 15, 'growth', m * 15],
        [9003, 'Virtualization', 'tenant', null, 'vm:build', 6400, 'large', null],
      ]
      for (const [pid, name, cls, repo, tenant, footprint, why, grown] of process)
        await sql`INSERT INTO factory.host_process_samples (at, pid, ppid, name, class, repo, tenant, footprint_mib, cpu_ms, why, grown_mib)
          VALUES (${at}, ${pid}, 1, ${name}, ${cls}, ${repo}, ${tenant}, ${footprint}, 500, ${why}, ${grown})`
    }
  }

  const finding = async (
    id: string,
    project: string,
    kpi: string,
    subject: string,
    values: [number, number, number | null, string],
    status: string,
    filedHoursAgo: number,
  ) => {
    const [before, target, after, unit] = values
    const shipped = status === 'open' ? null : new Date(now - (filedHoursAgo - 20) * HOUR)
    await sql`INSERT INTO factory.throughput_findings
      (id, project, kpi, subject, before, target, after, direction, unit, cost_minutes, query, filed_at, shipped_at, after_at, status)
      VALUES (${id}, ${project}, ${kpi}, ${subject}, ${before}, ${target}, ${after}, 'down', ${unit}, 120,
        'factory read throughput', ${new Date(now - filedHoursAgo * HOUR)}, ${shipped},
        ${after === null || shipped === null ? null : new Date(shipped.getTime() + 72 * HOUR)}, ${status})`
  }
  await finding('tpf_open', 'argo', 'failed_run_minutes', '*', [95, 48, null, 'minutes'], 'open', 20)
  await finding('tpf_moved', 'argo', 'step_peak_mib', 'full', [4300, 2048, 1900, 'MiB'], 'moved', 200)
  await finding('tpf_flat', 'zeta', 'slot_minutes_per_issue', '*', [60, 45, 58, 'minutes'], 'flat', 150)
  await finding('tpf_worse', 'zeta', 'process_growth_mib', 'node', [1400, 700, 2100, 'MiB'], 'worse', 120)
  await finding('tpf_wait', 'software-factory', 'queued_minutes', '*', [310, 155, null, 'minutes'], 'shipped', 60)
}

/**
 * The lead time of the Issues the world closed (call it after the world is seeded): each gets one lead attempt that
 * started three hours before its close, a turn of 30 minutes, a check step of 10 minutes that waited 2 for a slot, and
 * the rest idle, so the page's lead band has a split to read. Returns the Issues it gave a lead.
 */
export async function seedLeadTime(sql: SQL): Promise<string[]> {
  const closed: Array<{ issue_id: string; at: Date; repo: string }> = await sql`
    SELECT e.issue_id, e.at, i.repo FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.result = 'applied' AND e.to_state = 'closed' AND e.at > now() - interval '20 hours'
    ORDER BY e.at DESC LIMIT 4`
  for (const [n, { issue_id: issue, at, repo }] of closed.entries()) {
    const number = issue.replace('issue_', '')
    const at3 = new Date(at.getTime() - 3 * HOUR - n * 20 * MINUTE)
    const at2 = new Date(at3.getTime() + 30 * MINUTE)
    await sql`INSERT INTO factory.lead_attempts (issue_id, attempt, branch, worktree_path, first_try_at, started_at)
      VALUES (${issue}, 1, ${`factory/${number}-1`}, ${`/work/factory-${number}-1`}, ${at3}, ${at3})`
    for (const [kind, when] of [
      ['turn_started', at3],
      ['turn_ended', at2],
    ] as const)
      await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at)
        VALUES (${`${issue}-${kind}`}, ${`lead-${number}-1`}, ${issue}, 1, ${kind}, ${when}, ${when})`
    await sql`INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, duration_ms, wait_ms, cwd)
      VALUES (${new Date(at2.getTime() + 15 * MINUTE)}, ${`factory-${number}-1 ${repo} check`}, ${repo}, 2400, ${10 * MINUTE}, ${2 * MINUTE},
        ${`/work/factory-${number}-1`})`
  }
  return closed.map((c) => c.issue_id)
}
