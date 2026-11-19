import type { CapacityLoopModel, ThroughputModel } from '@software-factory/contract'
import { hostSentence, improvementSentence } from './throughput-answers.ts'
import { isWorkRepo, type OpenProject, REDACTED_REPO } from './work.ts'

type WaitRepo = CapacityLoopModel['slotWait']['byRepo'][number]
type WaitReason = WaitRepo['byReason'][number]
type Wait = Pick<WaitRepo, 'waits' | 'totalMs' | 'p50Ms' | 'p90Ms' | 'maxMs'>

/**
 * The three answers as a lead sees them: the queue's own words for a memory wait can name a repo, and a finding names its
 * project, so neither reaches it; the sentences are rebuilt without them.
 */
export function redactAnswers(
  answers: ThroughputModel['answers'],
  open: readonly OpenProject[],
): ThroughputModel['answers'] {
  const { host, cost } = answers
  const finding = cost.finding
  return {
    ...answers,
    host: {
      ...host,
      waitingFor: null,
      sentence: hostSentence({ ...host, waiting: host.waitingFor !== null, waitingText: null }),
    },
    cost:
      finding && isWorkRepo(finding.project, open)
        ? {
            ...cost,
            finding: { ...finding, project: REDACTED_REPO, subject: '*' },
            sentence: improvementSentence({
              project: REDACTED_REPO,
              kpi: finding.kpi,
              subject: '*',
              costMinutes: cost.figure ?? 0,
            }),
          }
        : cost,
  }
}

/**
 * The capacity loop as the read token sees it: the hours and the waits behind each reason stay, the work repos among them
 * are summed under one name (`REDACTED_REPO`). That covers the repo split of `queueByReason` and of `slotWait.byRepo`.
 * A work repo's lead and its steps (`<project> <kind>`) are left out: a lead row or a step row has no sum to fold into.
 */
export function redactCapacityLoop(model: CapacityLoopModel, open: readonly OpenProject[]): CapacityLoopModel {
  return {
    ...model,
    queueByReason: model.queueByReason.map((reason) => {
      const merged = new Map<string, CapacityLoopModel['queueByReason'][number]['byRepo'][number]>()
      for (const row of reason.byRepo) {
        const repo = isWorkRepo(row.repo, open) ? REDACTED_REPO : row.repo
        const had = merged.get(repo)
        merged.set(repo, {
          repo,
          queuedHours: (had?.queuedHours ?? 0) + row.queuedHours,
          issues: (had?.issues ?? 0) + row.issues,
        })
      }
      return { ...reason, byRepo: [...merged.values()].toSorted((a, b) => b.queuedHours - a.queuedHours) }
    }),
    slotWait: { ...model.slotWait, byRepo: redactWaitRepos(model.slotWait.byRepo, open) },
    leadCosts: model.leadCosts.filter((lead) => !isWorkRepo(lead.repo, open)),
    topSteps: model.topSteps.filter((step) => !isWorkRepo(stepProject(step.name), open)),
  }
}

/** A step is named `<project> <kind>`: its project is the first word. */
function stepProject(step: string): string {
  return step.split(' ')[0] ?? step
}

function redactWaitRepos(rows: readonly WaitRepo[], open: readonly OpenProject[]): WaitRepo[] {
  const groups = new Map<string, WaitRepo[]>()
  for (const row of rows) {
    const repo = isWorkRepo(row.repo, open) ? REDACTED_REPO : row.repo
    groups.set(repo, [...(groups.get(repo) ?? []), row])
  }
  return [...groups]
    .map(([repo, group]) => ({ repo, ...sumWaits(group), byReason: sumReasons(group.flatMap((row) => row.byReason)) }))
    .toSorted((a, b) => b.totalMs - a.totalMs)
}

function sumReasons(rows: readonly WaitReason[]): WaitReason[] {
  const groups = new Map<WaitReason['reason'], Wait[]>()
  for (const row of rows) groups.set(row.reason, [...(groups.get(row.reason) ?? []), row])
  return [...groups]
    .map(([reason, group]) => ({ reason, ...sumWaits(group) }))
    .toSorted((a, b) => b.totalMs - a.totalMs)
}

/** Counts and ms add, the largest max stays; a percentile of a sum is not known, so it stays only for a single row. */
function sumWaits(rows: readonly Wait[]): Wait {
  const only = rows.length === 1 ? rows[0] : undefined
  return {
    waits: rows.reduce((sum, row) => sum + row.waits, 0),
    totalMs: rows.reduce((sum, row) => sum + row.totalMs, 0),
    p50Ms: only?.p50Ms ?? null,
    p90Ms: only?.p90Ms ?? null,
    maxMs: rows.reduce<number | null>(
      (max, row) => (row.maxMs === null ? max : Math.max(max ?? row.maxMs, row.maxMs)),
      null,
    ),
  }
}

/** A count per repo with every work repo summed under one name. */
function redactCounts(counts: Record<string, number>, name: (repo: string) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [repo, n] of Object.entries(counts)) out[name(repo)] = (out[name(repo)] ?? 0) + n
  return out
}

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
    answers: redactAnswers(model.answers, open),
    series: {
      ...model.series,
      points: model.series.points.map((point) => ({
        ...point,
        runningByRepo: redactCounts(point.runningByRepo, repo),
        queuedByRepo: redactCounts(point.queuedByRepo, repo),
      })),
    },
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
      byHost: model.tests.byHost,
      // a step is named `<project> <kind>`: a work repo's steps and what they failed on stay out
      remote: {
        ...model.tests.remote,
        steps: model.tests.remote.steps.filter((row) => keep(stepProject(row.step))),
      },
      flaky: model.tests.flaky.filter((row) => keep(row.repo)),
    },
    lead: { ...model.lead, issues: model.lead.issues.map((row) => ({ ...row, repo: repo(row.repo) })) },
    project: model.project.map((row) => ({ ...row, repo: repo(row.repo) })),
    improvements: model.improvements.map((row) =>
      keep(row.project) ? row : { ...row, project: REDACTED_REPO, subject: '*' },
    ),
  }
}
