import type { ThroughputModel } from '@software-factory/contract'
import { isWorkRepo, type OpenProject, REDACTED_REPO } from './work.ts'

/**
 * What a lead sees of the throughput read: every figure stays, the names of work repos and tenants go (`private`). A lead
 * measures its own change against these numbers; it never learns which work repo or tenant a row belongs to. The owner and
 * the orchestrator read the model as it is.
 */
export function redactThroughput(model: ThroughputModel, open: readonly OpenProject[]): ThroughputModel {
  const repo = (name: string): string => (isWorkRepo(name, open) ? REDACTED_REPO : name)
  const keep = (name: string): boolean => !isWorkRepo(name, open)
  return {
    ...model,
    host: {
      ...model.host,
      byRepo: model.host.byRepo.map((row) => ({ ...row, repo: repo(row.repo) })),
      byTenant: model.host.byTenant.map((row) => ({ ...row, tenant: REDACTED_REPO })),
      topProcesses: model.host.topProcesses.map((row) => ({
        ...row,
        name: row.class === 'tenant' || (row.repo !== null && !keep(row.repo)) ? REDACTED_REPO : row.name,
        repo: row.repo === null ? null : repo(row.repo),
        tenant: row.tenant === null ? null : REDACTED_REPO,
      })),
    },
    tests: {
      byProject: model.tests.byProject.map((row) => ({ ...row, repo: repo(row.repo) })),
      flaky: model.tests.flaky.filter((row) => keep(row.repo)),
    },
    lead: { ...model.lead, issues: model.lead.issues.map((row) => ({ ...row, repo: repo(row.repo) })) },
    project: model.project.map((row) => ({ ...row, repo: repo(row.repo) })),
    improvements: model.improvements.map((row) =>
      keep(row.project) ? row : { ...row, project: REDACTED_REPO, subject: '*' },
    ),
  }
}
