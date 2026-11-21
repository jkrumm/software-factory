import type { HygieneFinding } from '@software-factory/contract'
import type { FixEntry, SweepReport } from './hygiene-model.ts'
import type { FindingIssue, LifecycleAction } from './hygiene-lifecycle.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { FixCommit, FixCommitRow } from './fix-causes.ts'

/** What `factory-hygiene` made of a sweep's documents; `skipped` is final (nothing to judge), `failed` is retried a few times. */
export interface HygieneJudgment {
  outcome: 'answered' | 'failed' | 'skipped'
  attempts: number
  judgedAt: Date | null
  reason: string
  /** the findings that passed the factory's own check */
  findings: HygieneFinding[]
}

/** One full hygiene pass over one project as recorded (`migrations/0970_hygiene.sql`). */
export interface HygienePassRecord {
  id: string
  repo: string
  at: Date
  ref: string
  report: SweepReport
  judgment: HygieneJudgment
  filed: { key: string; title: string }[]
  /** left out by the cap or by a held class */
  overBudget: { key: string; title: string }[]
  failed: { key: string; reason: string }[]
  /** what the pass did to findings already filed (`migrations/1047_hygiene_lifecycle.sql`) */
  lifecycle: { key: string; issue: string; action: LifecycleAction; why: string; at: Date }[]
  /** the scripted fixes the pass ran (`migrations/1053_hygiene_fixes.sql`); a pass recorded before the column has none */
  fixes: (FixEntry & { at: Date })[]
}

/** The fix commits of one project's default branch, read from git (called outside any transaction). */
export interface FixCommitReader {
  read(repo: string, since: Date): Promise<Result<FixCommit[], PortError>>
}

/** The hygiene loop's own tables, inside one transaction: its passes and the fix commits it stored. */
export interface HygieneStore {
  /** the newest hygiene pass of each repo */
  hygienePasses(): Promise<HygienePassRecord[]>
  recordHygienePass(pass: HygienePassRecord): Promise<void>
  /** a judgment retry: the pass's judgment and the lists it extended, as the whole new values */
  updateHygieneJudgment(
    id: string,
    next: Pick<HygienePassRecord, 'judgment' | 'filed' | 'overBudget' | 'failed'>,
  ): Promise<void>
  /** the shas of one repo's fix commits stored already (`migrations/0997_fix_commits.sql`) */
  storedFixShas(repo: string): Promise<Set<string>>
  /** a repeat is a no-op */
  recordFixCommits(rows: readonly FixCommitRow[]): Promise<void>
}

/** Read-only SQL on other domains' tables for the hygiene pass (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface HygieneReads {
  /** the newest Issue each hygiene finding key of one repo filed, with how it stands (the lifecycle's input) */
  findingIssues(repo: string): Promise<FindingIssue[]>
}
