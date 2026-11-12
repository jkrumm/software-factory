import type { Effort, Tier } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { Result } from '../../kernel/result.ts'
import type { HookFact } from './session.ts'

// --- the world, behind ports ------------------------------------------------------------------------------------

/** One terminal of herdr-core as the leads read it. */
export interface TerminalInfo {
  address: string
  /** running; a finished terminal ended, whatever it was running */
  live: boolean
  /** the agent in it reported (a status or a turn): it started */
  reported: boolean
  status: string | null
  turn: number
  exitCode: number | null
  tab: string | null
  /** the name the factory wants on the tab (label `factory.tab_name`); null for a terminal that carries none */
  tabName: string | null
  space: string | null
}

export interface StartTerminal {
  /** the spawn key: the terminal's label `factory.key`, the session's `FACTORY_SESSION` */
  key: string
  /** the lead's worktree */
  cwd: string
  /** the path whose space holds the tab: the repo's main checkout */
  space: string
  prompt: string
  tier: Tier
  effort: Effort
  account: string
  /** the name the lead's tab gets in the app, once the app has adopted the tab */
  tabName: string
}

/** herdr-core. Every call has a process timeout; `start` looks before it acts, so a replay never starts a second terminal. */
export interface Terminals {
  /** every terminal that carries the key, live or finished */
  find(key: string): Promise<Result<TerminalInfo[]>>
  /** the key's running agent if there is one, else a new terminal with the prompt as the program's last argument */
  start(input: StartTerminal): Promise<Result<TerminalInfo>>
  /** `busy` unless the agent waits at its prompt; `force` also types into a working agent, which queues it for its next turn */
  type(input: { terminal: string; text: string; force: boolean }): Promise<Result<'typed' | 'busy'>>
  /** ends the key's terminals and takes them away; none left is what was asked for */
  close(key: string): Promise<Result<void>>
  /**
   * Best effort, never throws: names the tab only if the app's entry for it exists and has no name yet. A tab already
   * named (by the factory or the owner) is never overwritten.
   */
  nameTab(input: { tab: string; name: string }): Promise<void>
}

export interface Worktree {
  path: string
  /** `origin/<default>` */
  base: string
  /** the commit it was cut from */
  sha: string
}

export type WorktreeRemoval = { removed: true } | { kept: string; path: string | null }

/** git on the host. `create` is idempotent per branch; `remove` takes the worktree away only when nothing would be lost. */
export interface Worktrees {
  create(input: { repo: string; branch: string }): Promise<Result<Worktree>>
  remove(input: { repo: string; branch: string }): Promise<Result<WorktreeRemoval>>
}

/** How the Issue ended, as far as its branches care: a dropped or cancelled one has no work worth keeping. */
export type BranchClosure = 'dropped' | 'cancelled' | 'other'

export interface BranchCleaning {
  /** the `factory/<n>-<attempt>` branches gone, local and on the remote */
  deleted: string[]
  kept: { branch: string; why: string }[]
}

/**
 * The branches a closed Issue's leads left, `factory/<issue>-*` and no other number. A branch goes when the Issue was
 * dropped or cancelled, or its work is on the remote default (by ancestry, an empty merge, a shipped commit or a merged
 * pull request); any failure on a branch keeps it and says why. Deleting twice is the same as once.
 */
export interface LeadBranches {
  clean(input: {
    repo: string
    issue: number
    closed: BranchClosure
    shipped: readonly string[]
  }): Promise<Result<BranchCleaning>>
}

/** The trust boundary: a repo is a directory strictly inside an allowed root, after `realpath`. */
export interface Repos {
  locate(repo: string): Promise<Result<string>>
}

/** The project's check tiers (`project.yaml` `checks:`), as the brief states them. */
export interface CheckTiers {
  fast: string
  full: string
  /** CI runs `full` on the pull request head, so the lead relies on that run */
  ci: boolean
}

/** The check tiers of the project a repo belongs to; `null` for a project with none: its lead runs `make check` as before. */
export interface Checks {
  of(repo: string): Promise<Result<CheckTiers | null>>
}

/** The role table, as it is when asked: the `lead` row when a lead starts, any row when an Issue is filed with a seat. */
export interface Roles {
  lead(): Promise<Result<{ tier: Tier; effort: Effort }>>
  /** a named row; `refused` for a role the table lacks, `unreadable` for a table that cannot be read */
  role(name: string): Promise<Result<{ tier: Tier; effort: Effort }>>
}

/** Capacity's: the account a lead runs on, the repo claim it holds, the window that can run out. Package 3 brings the real ones. */
export interface Seats {
  seat(input: { issue: IssueId; attempt: number }): Promise<Result<{ account: string }>>
}

export interface Claims {
  /** gives back the repo claim of the attempt; giving back twice is the same as once */
  release(input: { issue: IssueId; attempt: number }): Promise<Result<void>>
  /**
   * takes the repo claim back for a lead whose wait ended, before it is told so; `refused` while the repo is full (the
   * outbox tries again), `gone` when the Issue is closed. Holding one already is the same as taking one.
   */
  resume(input: { issue: IssueId; attempt: number }): Promise<Result<void>>
}

export interface Windows {
  /** when the account's window opens again, if capacity knows */
  wall(account: string): Promise<Result<{ resetAt: Date | null }>>
}

/** Copies the attempt's transcripts where they outlive Claude Code's own cleanup. */
export interface Transcripts {
  archive(input: {
    issue: IssueId
    attempt: number
    account: string | null
    sessions: readonly { claudeSession: string; transcriptPath: string }[]
  }): Promise<Result<{ archived: number }>>
}

// --- the domain's own tables, inside one transaction ----------------------------------------------------------------

/** A lead's attempt as its tables hold it: filled in step by step, each step a fact that a replay finds again. */
export interface LeadAttempt {
  issueId: IssueId
  attempt: number
  branch: string
  account: string | null
  repoPath: string | null
  worktreePath: string | null
  baseSha: string | null
  terminal: string | null
  tab: string | null
  space: string | null
  firstTryAt: Date
  tries: number
  startedAt: Date | null
  goneAt: Date | null
}

export interface Delivery {
  /** the effect's key, or the brief's */
  key: string
  issueId: IssueId
  attempt: number
  kind: 'brief' | 'note'
  text: string
  claimedAt: Date
  typedAt: Date | null
  forced: boolean
}

export const FINALIZE_STEPS = ['claim', 'terminals', 'transcripts', 'worktree'] as const
export type FinalizeStep = (typeof FINALIZE_STEPS)[number]

export interface Finalization {
  issueId: IssueId
  attempt: number
  steps: Partial<Record<FinalizeStep, Date>>
  archived: number
  worktreeKept: string | null
  worktreePath: string | null
  doneAt: Date | null
}

/** A signal an Issue was filed from, as the brief shows it: read-only, from intake's table (the leads never import intake). */
export interface BriefSignal {
  source: string
  title: string
  text: string
  /** the alert's facts (the source's numbers), or null for a signal with none */
  facts: unknown
  at: Date
}

/** The Spec a filer attached to an Issue (`issue new --spec`), as the brief shows it: read-only, from the checkpoints' tables. */
export interface BriefSpec {
  artifact: string
  title: string
  /** the verdict on its latest revision (a factory default after 24 hours says so in its note); null while there is none */
  verdict: { verdict: string; note: string | null } | null
}

export interface LeadStore {
  /** the signals an Issue was filed from or joined, oldest first, at most `limit` */
  signalsOf(issue: IssueId, limit: number): Promise<BriefSignal[]>
  /** the Spec the Issue was filed with, or null */
  filedSpecOf(issue: IssueId): Promise<BriefSpec | null>

  attempt(issue: IssueId, attempt: number): Promise<LeadAttempt | null>
  /** the attempt's row, made on the first try; every later try counts */
  tried(issue: IssueId, attempt: number, branch: string, at: Date): Promise<LeadAttempt>
  saveWorktree(
    issue: IssueId,
    attempt: number,
    input: { account: string; repoPath: string; worktreePath: string; baseSha: string },
  ): Promise<void>
  saveStarted(
    issue: IssueId,
    attempt: number,
    input: { terminal: string; tab: string | null; space: string | null; at: Date },
  ): Promise<void>
  markGone(issue: IssueId, attempt: number, at: Date): Promise<void>
  /** attempts with a terminal that are not marked gone: the ones to look at */
  followed(): Promise<LeadAttempt[]>

  /** false when the key is stored already: a replay */
  appendHook(input: {
    issue: IssueId
    attempt: number
    session: string
    fact: Omit<HookFact, 'seq'>
    receivedAt: Date
  }): Promise<boolean>
  hookFacts(session: string): Promise<HookFact[]>

  delivery(key: string): Promise<Delivery | null>
  /** false when the key is claimed already */
  claimDelivery(delivery: Omit<Delivery, 'typedAt' | 'forced'>): Promise<boolean>
  markTyped(key: string, at: Date, forced: boolean): Promise<void>
  /** the typing times of an attempt's deliveries: what tells a turn the factory started from one the owner did */
  typedAt(issue: IssueId, attempt: number): Promise<Date[]>

  /** false when this turn was sent back already */
  recordSendBack(input: { key: string; issue: IssueId; attempt: number; turn: number; at: Date }): Promise<boolean>
  sentBack(key: string): Promise<boolean>

  finalization(issue: IssueId, attempt: number): Promise<Finalization | null>
  markStep(
    issue: IssueId,
    attempt: number,
    step: FinalizeStep,
    at: Date,
    detail?: { archived?: number; kept?: string | null; path?: string | null },
  ): Promise<void>
  markFinalized(issue: IssueId, attempt: number, at: Date): Promise<void>
}
