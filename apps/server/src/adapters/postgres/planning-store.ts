import type { SQL } from 'bun'
import * as z from 'zod'
import type { Edge } from '../../domains/planning/chain.ts'
import { PlanFile } from '../../domains/planning/plan.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { ProjectFile } from '../../domains/planning/project.ts'
import type { FileError, StoredProject } from '../../domains/planning/sync.ts'
import { type IssueId, issueId } from '../../kernel/ids.ts'

const FileErrorColumn = z.object({ message: z.string(), sha: z.string().nullable() })

const ProjectRow = z.object({
  name: z.string(),
  repo: z.string(),
  source: z.enum(['file', 'defaults']),
  project: z.unknown(),
  project_sha: z.string().nullable(),
  project_error: z.unknown(),
  plan: z.unknown(),
  plan_sha: z.string().nullable(),
  plan_error: z.unknown(),
  plan_warnings: z.array(z.string()),
  branch: z.string().nullable(),
  synced_at: z.date().nullable(),
})

const errorOf = (raw: unknown): FileError | null => (raw == null ? null : FileErrorColumn.parse(raw))

function projectOf(raw: unknown): StoredProject {
  const row = ProjectRow.parse(raw)
  return {
    name: row.name,
    repo: row.repo,
    source: row.source,
    project: ProjectFile.parse(row.project),
    projectSha: row.project_sha,
    projectError: errorOf(row.project_error),
    plan: row.plan == null ? null : PlanFile.parse(row.plan),
    planSha: row.plan_sha,
    planError: errorOf(row.plan_error),
    planWarnings: row.plan_warnings,
    branch: row.branch,
    syncedAt: row.synced_at,
  }
}

const EdgeRow = z.object({ issue_id: z.string(), after_issue: z.string(), satisfied: z.boolean() })
const PrioRow = z.object({ issue_id: z.string(), value: z.number().int() })
const FiledRow = z.object({ project: z.string(), row_key: z.string(), issue_id: z.string() })

const idOf = (text: string): IssueId => {
  const n = Number(text.slice('issue_'.length))
  return issueId(n)
}

/** Planning's tables on one transaction's connection. */
export function postgresPlanningStore(tx: SQL): PlanningStore {
  return {
    async projects() {
      const rows: unknown[] = await tx`SELECT * FROM factory.planning_projects ORDER BY name`
      return rows.map(projectOf)
    },

    async saveProject(project) {
      // The stored copy of the parsed files is re-parsed on every read, so what is written is what the schema outputs.
      await tx`
        INSERT INTO factory.planning_projects
          (name, repo, source, project, project_sha, project_error, plan, plan_sha, plan_error, plan_warnings, branch, synced_at)
        VALUES (
          ${project.name}, ${project.repo}, ${project.source}, ${project.project}, ${project.projectSha},
          ${project.projectError}, ${project.plan}, ${project.planSha}, ${project.planError},
          ${JSON.stringify(project.planWarnings)}::text::jsonb, ${project.branch}, ${project.syncedAt}
        )
        ON CONFLICT (name) DO UPDATE SET
          repo = EXCLUDED.repo, source = EXCLUDED.source, project = EXCLUDED.project,
          project_sha = EXCLUDED.project_sha, project_error = EXCLUDED.project_error, plan = EXCLUDED.plan,
          plan_sha = EXCLUDED.plan_sha, plan_error = EXCLUDED.plan_error, plan_warnings = EXCLUDED.plan_warnings,
          branch = EXCLUDED.branch, synced_at = EXCLUDED.synced_at`
    },

    async edges() {
      const rows: unknown[] = await tx`
        SELECT issue_id, after_issue, satisfied_at IS NOT NULL AS satisfied FROM factory.planning_edges`
      return rows.map((raw): Edge => {
        const row = EdgeRow.parse(raw)
        return { issue: idOf(row.issue_id), after: idOf(row.after_issue), satisfied: row.satisfied }
      })
    },

    async addEdge({ issue, after, at }) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.planning_edges (issue_id, after_issue, created_at) VALUES (${issue}, ${after}, ${at})
        ON CONFLICT DO NOTHING RETURNING issue_id`
      return rows.length === 1
    },

    async markSatisfied(edges, at) {
      for (const edge of edges) {
        await tx`
          UPDATE factory.planning_edges SET satisfied_at = ${at}
          WHERE issue_id = ${edge.issue} AND after_issue = ${edge.after} AND satisfied_at IS NULL`
      }
    },

    async prios() {
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (issue_id) issue_id, value FROM factory.planning_prios ORDER BY issue_id, at DESC, id DESC`
      return new Map(
        rows.map((raw) => {
          const row = PrioRow.parse(raw)
          return [idOf(row.issue_id), row.value] as const
        }),
      )
    },

    async recordPrio({ key, issue, value, actor, at }) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.planning_prios (key, issue_id, value, actor, at) VALUES (${key}, ${issue}, ${value}, ${actor}, ${at})
        ON CONFLICT (key) DO NOTHING RETURNING id`
      return rows.length === 1
    },

    async filedRows() {
      const rows: unknown[] = await tx`SELECT project, row_key, issue_id FROM factory.planning_filed_rows`
      return new Map(
        rows.map((raw) => {
          const row = FiledRow.parse(raw)
          return [`${row.project}:${row.row_key}`, idOf(row.issue_id)] as const
        }),
      )
    },

    async recordFiledRow({ project, key, issue, at }) {
      await tx`
        INSERT INTO factory.planning_filed_rows (project, row_key, issue_id, filed_at) VALUES (${project}, ${key}, ${issue}, ${at})
        ON CONFLICT (project, row_key) DO NOTHING`
    },
  }
}
