import type { Effort, Tier } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { Result, PortError } from '../../kernel/result.ts'
import type { ResumeRules } from './apierror.ts'
import type { HookFact } from './session.ts'
import type { ReaperAttempt, ReaperProc } from './reaper.ts'
import type { MainCheckoutLook } from './checkout.ts'

// --- the world, behind ports ------------------------------------------------------------------------------------

/** One terminal of herdr-core as the leads read it. */
export interface TerminalInfo {
  address: string
  /** running; a finished terminal ended, whatever it was running */
  live: boolean
  /** what runs in it is the agent itself, not the shell the core put in its place */
  agent: boolean
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
  /** the project's `env` (`project.yaml`): exported into the session; the factory's own variables win over it */
  env?: Readonly<Record<string, string>>
  /** the name the lead's tab gets in the app, once the app has adopted the tab */
  tabName: string
}

/** herdr-core. Every call has a process timeout; `start` looks before it acts, so a replay never starts a second terminal. */
export interface Terminals {
  /** every terminal that carries the key, live or finished */
  find(key: string): Promise<Result<TerminalInfo[]>>
  /** the key's running agent if there is one, else a new terminal with the prompt as the program's last argument */
  start(input: StartTerminal): Promise<Result<TerminalInfo>>
  /**
   * `busy` unless the agent waits at its prompt; `force` also types into a working agent, which queues it for its next turn.
   * An agent whose turn ended on an API error is blocked as far as herdr-core can tell (it takes "Please run /login" for a
   * dialog), yet it sits at an empty prompt: the screen shows that, and then the text is typed with the core's own override.
   * `idle`: the lead's own hooks say its turn ended and none began since, for a while. The core's status can disagree with
   * that for good (a resumed session read `working` or `blocked` for a day while it sat at its prompt), so a screen that
   * shows an empty input box, no dialog and no running turn is taken over the status and the text is typed with the override.
   */
  type(input: { terminal: string; text: string; force: boolean; idle?: boolean }): Promise<Result<'typed' | 'busy'>>
  /**
   * Gets an agent whose turn ended on an API error going again. The screen is looked at first: the API error line above an
   * empty prompt is what permits a forced send. A draft in the prompt box is submitted (`draft`: it is what the agent was
   * about to run, and a send would append to it); a screen that is not that state (a dialog, a running turn, no error line)
   * is `busy` and nothing is typed.
   */
  resume(input: { terminal: string; text: string }): Promise<Result<'continued' | 'draft' | 'busy'>>
  /**
   * The names of the owner's own plan sessions (live terminals named `plan-*`) whose screen shows an API error above the
   * prompt. Read only: they are counted in an edge incident's friction row, never resumed.
   */
  planErrors(): Promise<Result<string[]>>
  /**
   * Ends the key's running agent and keeps its finished terminal: the lead is dormant, its worktree and session stay. Ending
   * twice, or a key with nothing running, is the same as once.
   */
  quiesce(key: string): Promise<Result<void>>
  /**
   * Starts a dormant lead's session again, `claude --resume <session>` with the prompt as its first message, under the same
   * key and tab. The model and effort it ran on are read from the finished terminal's argv; `tier` and `effort` are only
   * for a core that no longer has it. A live agent under the key is the lead already running: nothing is started.
   */
  revive(input: StartTerminal & { session: string }): Promise<Result<TerminalInfo>>
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

export interface WorktreeRemovalInput {
  repo: string
  branch: string
  /** where the attempt's worktree was made: found by it first, because a lead may have detached or renamed the branch */
  path: string | null
  /** the commits the attempt shipped: one on the base means the work landed, however the merge rewrote it */
  shipped: readonly string[]
  /** whose worktree it is: its untracked files are archived under this Issue and attempt before the tree goes */
  issue: number
  attempt: number
}

/**
 * git on the host. `create` is idempotent per branch. `remove` takes the worktree away only when nothing would be lost: the
 * untracked files a lead left (scratch, replies) are copied to the archive first, a tracked change or a commit that is not
 * on the base keeps it. Whatever the outcome, the build output in it (`target/` beside a `Cargo.toml`, `node_modules`) goes.
 */
export interface Worktrees {
  create(input: { repo: string; branch: string }): Promise<Result<Worktree>>
  remove(input: WorktreeRemovalInput): Promise<Result<WorktreeRemoval>>
  /**
   * A dormant lead's worktree at the path it had: untouched when it is there, made again on its branch when something
   * removed it while the lead waited (`restored`). Never replaces a directory that is no worktree.
   */
  restore(input: { repo: string; branch: string; path: string }): Promise<Result<{ restored: boolean }>>
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

/** What a lead's start reads of the stored project a repo belongs to (the one in force, not a worktree's copy). */
export interface Checks {
  /** the check tiers; `null` for a project with none: its lead runs `make check` as before */
  of(repo: string): Promise<Result<CheckTiers | null>>
  /** the project's `env`: variables exported into every lead of the repo; empty for a repo with no project */
  env(repo: string): Promise<Result<Readonly<Record<string, string>>>>
}

/** Whether the lead's worktree has a `make merge-guard` target, so the brief says so and the lead does not look; null: unreadable. */
export interface MergeGuard {
  has(worktree: string): Promise<boolean | null>
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
  /**
   * Gives a walled attempt (its Issue waits as a `wall` stall) to another account that is open and has room, and its claim
   * with it. Null: it does not wait on a wall, or no other account takes it. The lead's session moves when the caller's wake
   * is delivered: its terminal is then started again on `seat`'s account.
   */
  move(input: { issue: IssueId; attempt: number }): Promise<Result<{ from: string; to: string } | null>>
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
  /**
   * when the account's window opens again, if capacity knows. `since` is when the lead hit the wall: a reading sampled
   * before it that shows the account open has not caught up with the wall, so the wait is for the window nearest its
   * limit to reset; a reading sampled after it that shows the account open means it is open.
   */
  wall(account: string, since?: Date): Promise<Result<{ resetAt: Date | null }>>
}

/** What the end of a session's transcript says of its last turn when that turn ended on an API error. */
export interface TranscriptApiError {
  at: Date
  /** Claude Code's `error` type, when the line has one */
  error: string | null
  /** Claude Code's `apiErrorStatus`, when it has one */
  status: number | null
  /** the rendered error text */
  text: string
}

/**
 * The end of a lead's transcript. A turn that ends on an API error fires no `Stop`; Claude Code only writes the error as the
 * assistant's last line, so this is how a session whose `StopFailure` hook never ran (or is not installed) is found.
 */
export interface TranscriptTails {
  /** the error the transcript ends on, or null when its last message is not one (or the file says nothing) */
  apiError(path: string): Promise<Result<TranscriptApiError | null>>
  /** the session's last assistant words, newest last, at most `max` characters; null when it said nothing readable */
  lastWords(path: string, max: number): Promise<Result<string | null>>
}

/** An account's login mark: capacity reads an open one as "not signed in". */
export interface AuthMarkRow {
  account: string
  markedAt: Date
  clearedAt: Date | null
  errandKey: string
  label: string
}

/** The Errand "log in account X" and whether it is still open, on the checkpoints' side. */
export interface LoginErrands {
  /** raises it once per key: the same words are the same Errand */
  raise(input: { account: string; key: string; label: string }): Promise<Result<void>>
  /** the request keys of the open Errands of this kind */
  open(): Promise<Result<ReadonlySet<string>>>
}

/** What the API-error path needs beyond the leads' own ports. */
export interface ApiErrorPorts {
  tails: TranscriptTails
  errands: LoginErrands
  rules: ResumeRules
  /** a session whose open turn has been silent this long has the end of its transcript read for an API error */
  detectAfterMs: number
  /** a session's transcript is read at most this often */
  probeEveryMs: number
}

/** One process of the host as quiescing reads it: a lead's tree is the processes that carry its `FACTORY_SESSION`. */
export interface QuiesceProcess {
  pid: number
  ppid: number
  session: string | null
}

/** What quiescing needs of the host, beyond the leads' own ports. */
export interface QuiescePorts {
  /** a lead whose Issue has waited this long, quiet, is dormant */
  afterMs: number
  /** the host's process table; null when `ps` could not answer (nothing is dormant on a guess) */
  processes(): Promise<QuiesceProcess[] | null>
  /** the working directories of the slots granted now: a slot held from a lead's worktree keeps it running */
  slotCwds(): Promise<string[]>
  /** failed resumes after which the dormant lead is called gone */
  maxReviveTries: number
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
  /** the lead's `claude` was ended while its Issue waited; the wake starts the session again */
  dormantAt: Date | null
  /** resumes of the dormant session that failed since it was dormant */
  reviveTries: number
  /** the seat the lead ran on, set when it started (null: started before the column, or its event carried none) */
  seat: { tier: Tier; effort: Effort } | null
}

export interface Delivery {
  /** the effect's key, or the brief's */
  key: string
  issueId: IssueId
  attempt: number
  kind: 'brief' | 'note' | 'resume'
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

/** What the light seat's rule reads about where an Issue came from. */
export interface SeatOrigin {
  hygieneKey: string | null
  unroutedMonitor: boolean
  /** the titles and texts of the signals the Issue was filed from and its first note (what `issue new` and a plan row file their facts as), joined; empty when it had none */
  text: string
}

/** A finalized attempt of a closed Issue whose worktree was kept: what `remove` may take another look at. */
export interface KeptWorktree {
  issue: IssueId
  attempt: number
  repo: string
  path: string
  /** the reason stored with it (may also carry branch notes) */
  kept: string | null
}

export interface LeadStore {
  /** the kept worktrees of closed Issues, newest Issue first */
  keptWorktrees(): Promise<KeptWorktree[]>
  /** the signals an Issue was filed from or joined, oldest first, at most `limit` */
  signalsOf(issue: IssueId, limit: number): Promise<BriefSignal[]>
  /** the Spec the Issue was filed with, or null */
  filedSpecOf(issue: IssueId): Promise<BriefSpec | null>
  /** what the light seat's rule reads beyond the Issue: the hygiene finding that filed it, an unrouted monitor filed home, the text of its signals */
  originOf(issue: IssueId): Promise<SeatOrigin>

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
    input: {
      terminal: string
      tab: string | null
      space: string | null
      at: Date
      seat: { tier: Tier; effort: Effort }
    },
  ): Promise<void>
  markGone(issue: IssueId, attempt: number, at: Date): Promise<void>
  /** the lead is dormant (marking twice keeps the first time) */
  markDormant(issue: IssueId, attempt: number, at: Date, account?: string): Promise<void>
  /** the dormant lead runs again: the mark and the failed resumes are cleared */
  markRevived(
    issue: IssueId,
    attempt: number,
    terminal?: { address: string; tab: string | null; space: string | null; account?: string },
  ): Promise<void>
  /** a resume of the dormant session failed; the count of failures including this one */
  reviveFailed(issue: IssueId, attempt: number): Promise<number>
  /** attempts with a terminal that are not marked gone: the ones to look at */
  followed(): Promise<LeadAttempt[]>
  /** the lead's terminal runs no agent: a loss is opened (one open at a time, a second call keeps the first) */
  markAgentLost(issue: IssueId, attempt: number, at: Date): Promise<void>
  /** the lead's agent runs again: the open loss, if any, is closed */
  markAgentFound(issue: IssueId, attempt: number, at: Date): Promise<void>
  /** the attempts whose loss is open */
  openLosses(): Promise<{ issueId: IssueId; attempt: number }[]>

  /** false when the key is stored already: a replay */
  appendHook(input: {
    issue: IssueId
    attempt: number
    session: string
    fact: Omit<HookFact, 'seq'>
    receivedAt: Date
  }): Promise<boolean>
  hookFacts(session: string): Promise<HookFact[]>

  /** the `continue` deliveries of an attempt, oldest first */
  resumesOf(issue: IssueId, attempt: number): Promise<Delivery[]>
  authMarks(): Promise<AuthMarkRow[]>
  /** marks the account (or marks it again after the owner cleared it) */
  markAuth(input: { account: string; at: Date; errandKey: string; label: string }): Promise<void>
  /** takes back a `continue` claim that typed nothing (an untyped claim only), so the next pass tries again */
  unclaimDelivery(key: string): Promise<void>
  clearAuth(account: string, at: Date): Promise<void>
  /**
   * one row per edge incident, its leads and window kept at the largest seen; a burst that starts within the incident gap
   * of an earlier row's end is the same outage (the same leads failing again) and grows that row
   */
  recordEdge(input: { key: string; firstAt: Date; lastAt: Date; leads: number; plans: number; at: Date }): Promise<void>

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

/** A signal the reaper sent to a process of a closed attempt (`dry`: the rows of the retired dry-run mode, kept until they age out). */
export interface ReapedRow {
  at: Date
  pid: number
  session: string
  worktree: string | null
  comm: string
  signal: 'SIGTERM' | 'SIGKILL' | 'dry'
  reason: 'session' | 'worktree'
  ageS: number
}

/** The host's processes with their lead session and directory; null when `ps` or `lsof` could not answer (never an error). */
export interface ReaperProcesses {
  read(): Promise<ReaperProc[] | null>
}

/** Ends a process. False when it was not signalled: gone already, or no longer the process that was decided on. */
export interface ProcessKiller {
  signal(target: { pid: number; ageS: number }, signal: 'SIGTERM' | 'SIGKILL'): Promise<boolean>
}

/** A watch whose last checks were all blocked, the newest with a failing `checkout` check: the checkout could not be moved to the shipped commit. */
export interface BlockedWatch {
  issue: IssueId
  watch: number
  attempt: number
  checks: number
  since: Date
  detail: string
}

/** The main checkout of a repo, read now (called outside any transaction). `null`: not locatable, not ours to look at. */
export interface MainCheckouts {
  look(repo: string): Promise<Result<MainCheckoutLook | null, PortError>>
}

/** The reaper's tables: the attempts it weighs and the signals it sent. */
export interface ReaperStore {
  /** the attempts the reaper weighs: those not finalized, and those finalized since `since` */
  reaperAttempts(since: Date): Promise<ReaperAttempt[]>
  /** the SIGTERMs recorded since `since`, oldest first */
  termedSince(since: Date): Promise<{ pid: number; ageS: number }[]>
  recordReaped(rows: readonly ReapedRow[]): Promise<void>
  /** drops the rows older than `before`; how many */
  pruneReaped(before: Date): Promise<number>
}

/** Read-only SQL on other domains' tables for the steward's look at the live leads' repos and their watches (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface LeadLoopReads {
  /** watching Issues whose open watch has had at least `streak` checks in a row, all blocked, and whose newest run has a failing `checkout` check */
  blockedCheckouts(streak: number, limit: number): Promise<BlockedWatch[]>
  /** the repos with a live lead (Issues `working` or `watching`) and those Issues, ordered by repo and id */
  liveRepos(limit: number): Promise<{ repo: string; issues: IssueId[] }[]>
}
