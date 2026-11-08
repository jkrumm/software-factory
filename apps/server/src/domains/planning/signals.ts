import { durationMs, type ProjectFile } from './project.ts'
import { repoTextOf, type StoredProject } from './sync.ts'

/** One `heal:` rule: a `down` of the source waits `graceMs` for its `up`, after the runbook. */
export interface HealRuleView {
  /** `<source>.down` */
  when: string
  graceMs: number
  runbook: 'make restart' | null
  max: number
}

/**
 * What a project says to the intake about itself: which automatic sources it listens to. The shape is intake's
 * `RepoSignals` field for field, so the adapter that wires intake to planning is `projectSignals` below and nothing else.
 */
export interface RepoSignalsView {
  /** the repo as an Issue names it: its directory's name (`repoTextOf`) */
  repo: string
  /** a repo without a `project.yaml` is a work repo and hears the owner only */
  work: boolean
  /** the host named in its project.yaml */
  host: string | null
  /** the automatic sources its `signals:` lists: `github`, `checks`, `launchd` */
  sources: string[]
  github: { label: string; author: string | null; since: string | null; checks: boolean } | null
  launchd: string[]
  heal: HealRuleView[]
}

export function signalsView(project: StoredProject): RepoSignalsView {
  const file: ProjectFile = project.project
  const github = file.signals.github
  const launchd = file.signals.launchd ?? []
  const sources = [
    ...(github ? ['github'] : []),
    ...(github?.checks ? ['checks'] : []),
    ...(launchd.length > 0 ? ['launchd'] : []),
  ]
  return {
    repo: repoTextOf(project),
    work: project.source === 'defaults',
    host: file.host ?? null,
    sources,
    github: github
      ? { label: github.label, author: github.author ?? null, since: github.since ?? null, checks: github.checks }
      : null,
    launchd,
    heal: file.heal.map((rule) => ({
      when: rule.when,
      graceMs: durationMs(rule.grace) ?? 0,
      runbook: rule.runbook ?? null,
      max: rule.max,
    })),
  }
}
