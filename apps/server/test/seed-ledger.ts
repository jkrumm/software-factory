import type { SQL } from 'bun'

/** One throughput finding as the ledger table holds it, from the status the tests think in; `id` is its Issue (`loop_findings.issue_id`). */
export interface SeededFinding {
  id: string
  project: string
  kpi: string
  subject?: string
  before: number
  target: number
  direction?: 'up' | 'down'
  unit: string
  costMinutes: number
  filedAt: Date
  status: 'open' | 'shipped' | 'moved' | 'flat' | 'worse' | 'dropped' | 'unmeasured'
  shippedAt?: Date | null
  after?: number | null
  afterAt?: Date | null
  signalId?: string | null
  reopens?: string | null
}

export async function seedFinding(sql: SQL, f: SeededFinding): Promise<void> {
  const verdict =
    f.status === 'dropped'
      ? 'unmeasured'
      : ['moved', 'flat', 'worse', 'unmeasured'].includes(f.status)
        ? f.status
        : null
  await sql`INSERT INTO factory.loop_findings
    (issue_id, loop, repo, class, key, filed_at, signal_id, figure, target, direction, unit, cost_minutes, shipped_at, measured, measured_at, verdict, reopens)
    VALUES (${f.id}, 'throughput', ${f.project}, ${f.kpi}, ${`${f.kpi}:${f.subject ?? '*'}`}, ${f.filedAt}, ${f.signalId ?? null}, ${f.before}, ${f.target},
      ${f.direction ?? 'down'}, ${f.unit}, ${f.costMinutes}, ${f.shippedAt ?? null}, ${f.after ?? null}, ${f.afterAt ?? null}, ${verdict}, ${f.reopens ?? null})`
}
