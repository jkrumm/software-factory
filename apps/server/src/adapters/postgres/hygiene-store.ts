import type { SQL } from 'bun'
import * as z from 'zod'
import type { HygienePassRecord, HygieneStore } from '../../domains/hygiene/ports.ts'

const json = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

const HygieneRow = z.object({
  id: z.string(),
  repo: z.string(),
  at: z.date(),
  ref: z.string(),
  report: z.unknown(),
  judgment: z.unknown(),
  filed: z.unknown(),
  over_budget: z.unknown(),
  failed: z.unknown(),
  lifecycle: z.unknown().optional(),
  fixes: z.unknown().optional(),
})

/** The lifecycle entries as stored: ISO times back to dates; a pass recorded before the column has none. */
const lifecycleOf = (value: unknown): HygienePassRecord['lifecycle'] =>
  ((json(value) ?? []) as { key: string; issue: string; action: string; why: string; at: string }[]).map((entry) => ({
    ...entry,
    action: entry.action as HygienePassRecord['lifecycle'][number]['action'],
    at: new Date(entry.at),
  }))

/** The scripted fixes as stored: ISO times back to dates; a pass recorded before the column has none. */
const fixesOf = (value: unknown): HygienePassRecord['fixes'] =>
  ((json(value) ?? []) as (Omit<HygienePassRecord['fixes'][number], 'at'> & { at: string })[]).map((entry) => ({
    ...entry,
    at: new Date(entry.at),
  }))

const hygieneOf = (raw: unknown): HygienePassRecord => {
  const row = HygieneRow.parse(raw)
  const judgment = json(row.judgment) as Omit<HygienePassRecord['judgment'], 'judgedAt'> & { judgedAt: string | null }
  return {
    id: row.id,
    repo: row.repo,
    at: row.at,
    ref: row.ref,
    report: json(row.report) as HygienePassRecord['report'],
    judgment: { ...judgment, judgedAt: judgment.judgedAt === null ? null : new Date(judgment.judgedAt) },
    filed: json(row.filed) as HygienePassRecord['filed'],
    overBudget: json(row.over_budget) as HygienePassRecord['overBudget'],
    failed: json(row.failed) as HygienePassRecord['failed'],
    lifecycle: lifecycleOf(row.lifecycle),
    fixes: fixesOf(row.fixes),
  }
}

/** The hygiene loop's tables (its passes, the fix commits it stored), on the transaction's connection. */
export function postgresHygieneStore(tx: SQL): HygieneStore {
  return {
    async hygienePasses() {
      // the newest pass of each repo and scope: the weekly (full) one carries the judgment, the daily one the cheap probes
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (repo, scope) * FROM (
          SELECT *, COALESCE(report->>'scope', 'full') AS scope FROM factory.hygiene_passes
        ) p ORDER BY repo, scope, at DESC`
      return rows.map(hygieneOf)
    },

    async recordHygienePass(pass) {
      await tx`
        INSERT INTO factory.hygiene_passes (id, repo, at, ref, report, judgment, filed, over_budget, failed, lifecycle, fixes)
        VALUES (${pass.id}, ${pass.repo}, ${pass.at}, ${pass.ref}, ${JSON.stringify(pass.report)}::jsonb,
          ${JSON.stringify(pass.judgment)}::jsonb, ${JSON.stringify(pass.filed)}::jsonb,
          ${JSON.stringify(pass.overBudget)}::jsonb, ${JSON.stringify(pass.failed)}::jsonb,
          ${JSON.stringify(pass.lifecycle)}::jsonb, ${JSON.stringify(pass.fixes)}::jsonb)`
    },

    async updateHygieneJudgment(id, next) {
      await tx`
        UPDATE factory.hygiene_passes
        SET judgment = ${JSON.stringify(next.judgment)}::jsonb, filed = ${JSON.stringify(next.filed)}::jsonb,
            over_budget = ${JSON.stringify(next.overBudget)}::jsonb, failed = ${JSON.stringify(next.failed)}::jsonb
        WHERE id = ${id}`
    },

    async storedFixShas(repo) {
      const rows: unknown[] = await tx`SELECT sha FROM factory.fix_commits WHERE repo = ${repo}`
      return new Set(rows.map((row) => z.object({ sha: z.string() }).parse(row).sha))
    },

    async recordFixCommits(rows) {
      for (const row of rows) {
        await tx`
          INSERT INTO factory.fix_commits (repo, sha, committed_at, subject, scope, class, by, reason)
          VALUES (${row.repo}, ${row.sha}, ${row.committedAt}, ${row.subject}, ${row.scope}, ${row.class}, ${row.by}, ${row.reason})
          ON CONFLICT (repo, sha) DO NOTHING`
      }
    },
  }
}
