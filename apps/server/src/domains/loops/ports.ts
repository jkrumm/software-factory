import type {
  DigestAnswer,
  DigestRequest,
  FixClassesAnswer,
  FixClassesRequest,
  HygieneAnswer,
  HygieneFinding,
  HygieneRequest,
  LoopName,
  QueueAnswer,
  QueueRequest,
  StewardAnswer,
  StewardStall,
  TriageAnswer,
  TriageCandidate,
  TriageRequest,
} from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { MainCheckoutLook } from './checkout.ts'
import type { DigestIssue, DigestRecord, LatestDigest } from './digest.ts'
import type { ReaperAttempt, ReaperProc } from './reaper.ts'
import type { CallLoop, CallOutcome, CallRow } from './calls.ts'
import type { ClassIssue, FindingLoop } from './classes.ts'
import type { FixCommit, FixCommitRow } from './fix-classes.ts'
import type { SweepReport } from './hygiene-model.ts'
import type {
  CiRun,
  HostMinute,
  MigrationSnapshot,
  ProcessMinute,
  SelfwatchChange,
  SelfwatchRow,
  WaitFact,
} from './selfwatch-model.ts'
import type { QueueAskRow, QueueEdge, RefusedEdge, QueueIssue } from './queue.ts'

/** One weekly friction pass as recorded (`migrations/0950_friction.sql`). */
export interface FrictionPassRecord {
  id: string
  at: Date
  windowFrom: Date
  windowTo: Date
  issues: number
  filed: { key: string; count: number; title: string }[]
  /** left out by the cap or by a held class */
  overBudget: { key: string; count: number }[]
  failed: { key: string; reason: string }[]
}

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
}

/** The loops' own tables, inside one transaction: the agw calls made, so none is made twice, and the friction and hygiene passes. */
/** What the capacity layer holds at one minute (all null when it could not be read). */
export interface CapacityFacts {
  /** the leads running: claims held */
  leads: number | null
  /** the Issues queued */
  queued: number | null
  /** the leads the enabled accounts may hold */
  seats: number | null
  /** the load ceiling in force */
  loadCeiling: number | null
}

/** One reading of the host (`migrations/1002_host_samples.sql`); a figure that could not be read is null. */
export interface HostReading {
  load: number | null
  memoryUsedPct: number | null
  swapUsedPct: number | null
  swapoutMbPer300s: number | null
}

/** The host signals the class snapshot reads beside the processes (`migrations/1022_host_classes.sql`); null when not read. */
export interface HostSignals {
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical */
  pressureLevel: number | null
  compressorMib: number | null
  processes: number | null
  cpuIdlePct: number | null
  vmFreeGib: number | null
  /** the CPU the host loop's helper processes took since the last snapshot */
  collectorCpuMs: number | null
}

/** One minute as stored: the reading, the capacity facts (`migrations/1010_lead_samples.sql`) and the host signals. */
export type HostSampleRecord = HostReading & CapacityFacts & HostSignals

/** One row of `host_class_samples`: a class, repo, tenant, Issue and step summed over the minute. */
export interface ClassSampleRow {
  class: string
  repo: string | null
  tenant: string | null
  issue: number | null
  step: string | null
  footprintMib: number
  cpuMs: number | null
  procs: number
}

/** One notable process of the minute (`host_process_samples`): its program name only, never its command line. */
export interface ProcessSampleRow {
  pid: number
  ppid: number
  name: string
  class: string
  repo: string | null
  tenant: string | null
  issue: number | null
  footprintMib: number
  cpuMs: number | null
  why: 'top' | 'large' | 'growth'
  grownMib: number | null
}

/** What one lead's process tree cost at a sample, by its worktree. */
export interface LeadSampleRow {
  worktree: string
  repo: string
  issue: number | null
  attempt: number | null
  rssMib: number
  /** the physical footprint; null when `top` could not be read (`migrations/1021_lead_footprint.sql`) */
  footprintMib: number | null
  procs: number
}

/** An attempt's worktree, from `lead_attempts`. */
export interface AttemptWorktree {
  path: string
  repo: string
  issue: number | null
  attempt: number | null
}

/** Reads the host. It never fails: a figure it cannot read is null in the record. */
export interface HostSampler {
  sample(): Promise<HostReading>
}

/** A signal the reaper sent (or, `dry`, would have sent) to a process of a closed attempt. */
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

export interface LoopStore {
  /** the newest stored digest of each project, by project name */
  latestDigests(): Promise<Map<string, LatestDigest>>
  /** a new row: digests are facts, the newest one is read */
  recordDigest(record: DigestRecord): Promise<void>
  /** the attempts the reaper weighs: those not finalized, and those finalized since `since` */
  reaperAttempts(since: Date): Promise<ReaperAttempt[]>
  /** the SIGTERMs recorded since `since`, oldest first */
  termedSince(since: Date): Promise<{ pid: number; ageS: number }[]>
  recordReaped(rows: readonly ReapedRow[]): Promise<void>
  /** drops the rows older than `before`; how many */
  pruneReaped(before: Date): Promise<number>
  /** one sample at `at` with the lead rows of that minute; a second one at the same instant is ignored */
  recordHostSample(at: Date, sample: HostSampleRecord, leads: readonly LeadSampleRow[]): Promise<void>
  /** drops the samples older than `before`; how many */
  pruneHostSamples(before: Date): Promise<number>
  /** drops the lead samples older than `before`; how many */
  pruneLeadSamples(before: Date): Promise<number>
  /** drops the test results older than `before`; how many */
  pruneTestResults(before: Date): Promise<number>
  /** the class rows and the notable processes of the minute at `at`; a process already stored at `at` is ignored */
  recordClassSnapshot(
    at: Date,
    classes: readonly ClassSampleRow[],
    processes: readonly ProcessSampleRow[],
  ): Promise<void>
  /** rolls every complete hour before `now`'s hour that has no rollup yet into `host_class_hours`; how many rows */
  rollUpClassHours(now: Date): Promise<number>
  /** drops the class and process rows older than `before`; how many */
  pruneClassSamples(before: Date): Promise<number>
  /** drops the hourly rollups older than `before`; how many */
  pruneClassHours(before: Date): Promise<number>
  /** the repos an Issue had an event in since `since`: the projects whose CI the ledger follows */
  ciLedgerRepos(since: Date): Promise<string[]>
  /** when the newest run of the repo in the ledger finished, null for a repo with none */
  newestCiRun(repo: string): Promise<Date | null>
  /** stores the runs, a run already stored (same repo and run id) is overwritten; how many rows */
  recordCiRuns(repo: string, runs: readonly CiLedgerRun[]): Promise<number>
  /** drops the runs that finished before `before`; how many */
  pruneCiRuns(before: Date): Promise<number>
  /** the worktrees of the attempts that are live or ended since `since` */
  attemptWorktrees(since: Date): Promise<AttemptWorktree[]>
  /** the rounds of one subject, oldest first */
  calls(loop: CallLoop, issue: IssueId, subject: string): Promise<CallRow[]>
  /** false when the round is claimed already (another pass came first) */
  claimCall(
    row: Pick<CallRow, 'key' | 'loop' | 'issueId' | 'subject' | 'round' | 'claimedAt' | 'leaseUntil'>,
  ): Promise<boolean>
  /** takes a call whose lease lapsed back for this pass; false when another pass did first */
  retakeCall(key: string, claimedAt: Date, leaseUntil: Date): Promise<boolean>
  /** at boot: no call of an earlier process is still running, so every open call's lease lapses now */
  lapseOpen(now: Date): Promise<number>
  finishCall(
    key: string,
    result: { outcome: CallOutcome; answer: unknown; detail: string | null; at: Date },
  ): Promise<void>
  /** the asks of `factory-queue` about one shape of a repo's queue, oldest first */
  queueAsks(repo: string, shape: string): Promise<QueueAskRow[]>
  /** false when the round is claimed already (another pass came first) */
  claimQueueAsk(
    row: Pick<QueueAskRow, 'key' | 'repo' | 'shape' | 'round' | 'claimedAt' | 'leaseUntil'>,
  ): Promise<boolean>
  /** takes an ask whose lease lapsed back for this pass; false when another pass did first */
  retakeQueueAsk(key: string, claimedAt: Date, leaseUntil: Date): Promise<boolean>
  finishQueueAsk(
    key: string,
    result: { outcome: CallOutcome; answer: unknown; detail: string | null; at: Date },
  ): Promise<void>
  /** what was done with an answer: the edges applied and refused, and the queue's shape after them */
  recordQueueApplied(
    key: string,
    result: { applied: QueueEdge[]; refused: RefusedEdge[]; afterShape: string },
  ): Promise<void>
  /** an answered ask has this shape, or left the queue in it: asking again would be the same question */
  shapeAsked(repo: string, shape: string): Promise<boolean>
  /** when the repo was last asked (claimed, a failed ask included); null before the first */
  lastQueueAskAt(repo: string): Promise<Date | null>
  /** when the newest friction pass ran; null before the first */
  lastFrictionPassAt(): Promise<Date | null>
  recordFrictionPass(pass: FrictionPassRecord): Promise<void>
  /** when each loop's pass last ended (`migrations/1000_loop_passes.sql`) */
  passes(): Promise<Map<LoopName, Date>>
  /** never moves a loop's time backwards */
  recordPass(name: LoopName, at: Date): Promise<void>
  /** the newest hygiene pass of each repo */
  hygienePasses(): Promise<HygienePassRecord[]>
  /** the newest hygiene pass of one repo; null before the first */
  lastHygienePass(repo: string): Promise<HygienePassRecord | null>
  recordHygienePass(pass: HygienePassRecord): Promise<void>
  /** a judgment retry: the pass's judgment and the lists it extended, as the whole new values */
  updateHygieneJudgment(
    id: string,
    next: Pick<HygienePassRecord, 'judgment' | 'filed' | 'overBudget' | 'failed'>,
  ): Promise<void>
  /** the class of finding an Issue was filed for (`migrations/0993_finding_classes.sql`); a repeat is a no-op */
  recordFinding(row: { issue: string; loop: FindingLoop; repo: string; class: string; key: string }): Promise<void>
  /** the shas of one repo's fix commits stored already (`migrations/0997_fix_commits.sql`) */
  storedFixShas(repo: string): Promise<Set<string>>
  /** a repeat is a no-op */
  recordFixCommits(rows: readonly FixCommitRow[]): Promise<void>
  /** every subject the self-watch loop remembers (`migrations/0998_selfwatch.sql`) */
  selfwatchRows(): Promise<SelfwatchRow[]>
  /** the pass's changes in one transaction: filed rows upserted whole, seen rows touched, absent rows cleared */
  applySelfwatch(change: SelfwatchChange): Promise<void>
}

/** An Issue that is still `settling`, with what triage needs to know of it. */
export interface SettlingRow {
  issue: IssueId
  repo: string
  title: string
  kind: 'feature' | 'bug' | 'chore' | 'docs' | 'incident'
  origin: string
  filedAt: Date
  fromAlert: boolean
  /** the filer stated its edges: triage adds none */
  statedEdges: boolean
  text: string
}

/** A watch whose last checks were all blocked: the checkout could not be moved to the shipped commit. */
export interface BlockedWatch {
  issue: IssueId
  watch: number
  attempt: number
  checks: number
  since: Date
  detail: string
}

/** A working or watching Issue that holds its repo's claim and waits (an open `after` edge) on Issues queued for want of one. */
export interface ClaimHolder {
  issue: IssueId
  state: 'working' | 'watching'
  /** the queued Issues of its own repo it is after */
  blockers: IssueId[]
}

/** A lead whose note is refused again and again because it waits for a claim in its repo. */
export interface ClaimRefusal {
  issue: IssueId
  repo: string
  /** the first refusal of the claim in the run of refusals the open note has met */
  since: Date
  /** how many times the note was refused for the claim */
  refusals: number
}

/** Read-only SQL on other domains' tables (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface LoopReads {
  /** every Issue not closed and every one closed at or after `since`, with its open `after` edges (the digest loop and its read) */
  digestIssues(since: Date): Promise<DigestIssue[]>
  /** open `note_lead` effects whose runs were refused for a claim (`waits for a claim in`), oldest first */
  claimRefusals(limit: number): Promise<ClaimRefusal[]>
  /** Issues waiting for a stall (`wall`, `unreported`, `blocked`, `lead_gone`, `regressed`), oldest first */
  stalled(limit: number): Promise<IssueId[]>
  /** Issues in `working`, oldest first: the steward reads each lead's session for one gone quiet */
  working(limit: number): Promise<IssueId[]>
  /** Issues still settling, oldest first */
  settling(limit: number): Promise<SettlingRow[]>
  /** the ids of the repo's Issues that are not closed, oldest first */
  openIssueIds(repo: string): Promise<IssueId[]>
  /** the Issues of the repo that are not closed, other than `excluding` */
  openIssues(repo: string, excluding: IssueId, limit: number): Promise<TriageCandidate[]>
  /** every open Issue that is not settling, with its priority and open blockers, for the queue loop */
  queueIssues(): Promise<QueueIssue[]>
  /** watching Issues whose open watch has had at least `streak` checks in a row, all blocked */
  blockedCheckouts(streak: number, limit: number): Promise<BlockedWatch[]>
  /** working or watching Issues with an open edge to one of `queued` (still queued, same repo): the claim deadlock */
  claimHolders(queued: readonly IssueId[], limit: number): Promise<ClaimHolder[]>
  /** the Issues each finding class of one loop filed (in every repo), with their closure and outcome, by class */
  classIssues(loop: FindingLoop): Promise<Record<string, ClassIssue[]>>
  /** the same for every loop and class */
  allClassIssues(): Promise<{ loop: FindingLoop; class: string; issues: ClassIssue[] }[]>
  /** the repos with a live lead (Issues `working` or `watching`) and those Issues, ordered by repo and id */
  liveRepos(limit: number): Promise<{ repo: string; issues: IssueId[] }[]>
  /** the timer and dependency waits of the repo's Issues, with the times their exit is judged from (self-watch) */
  openWaits(repo: string): Promise<WaitFact[]>
  /** the notable processes of the host's minutes since `since`, oldest first (self-watch: runaway growth) */
  processMinutes(since: Date): Promise<ProcessMinute[]>
  /** the host's minute samples since `since`, oldest first (self-watch: swap growth, the process count) */
  hostMinutes(since: Date): Promise<HostMinute[]>
}

/** The main checkout of a repo, read now (called outside any transaction). `null`: not locatable, not ours to look at. */
export interface MainCheckouts {
  look(repo: string): Promise<Result<MainCheckoutLook | null, PortError>>
}

/** `factory-steward`: what a stalled Issue needs when the rules do not say. */
export interface StewardWorkflow {
  ask(stall: StewardStall, key: Key): Promise<Result<StewardAnswer, PortError>>
}

/** `factory-triage` for an Issue that is settling: the Issues it must wait for. */
export interface SettleWorkflow {
  settle(request: Extract<TriageRequest, { mode: 'settle' }>, key: Key): Promise<Result<TriageAnswer, PortError>>
}

/** `factory-queue`: edges and an order for a repo's queued Issues. */
export interface QueueWorkflow {
  ask(request: QueueRequest, key: Key): Promise<Result<QueueAnswer, PortError>>
}

/** `factory-hygiene`: the documents a sweep picked, read against the code they describe in a checkout. */
export interface HygieneWorkflow {
  ask(request: HygieneRequest, key: Key): Promise<Result<HygieneAnswer, PortError>>
}

/** `factory digest`: one project's recent, running and queued Issues summarised. */
export interface DigestWorkflow {
  digest(request: DigestRequest, key: Key): Promise<Result<DigestAnswer, PortError>>
}

/** `factory-fix-classes`: the class of each fix commit the rules did not settle. */
export interface FixClassesWorkflow {
  ask(request: FixClassesRequest, key: Key): Promise<Result<FixClassesAnswer, PortError>>
}

/** The fix commits of one project's default branch, read from git (called outside any transaction). */
export interface FixCommitReader {
  read(repo: string, since: Date): Promise<Result<FixCommit[], PortError>>
}

/** The newest completed workflow runs of a repo's branch (called outside any transaction). `branch` null is the repo's default branch. */
export interface CiRuns {
  latest(repo: string, branch: string | null): Promise<Result<{ branch: string; runs: CiRun[] }, PortError>>
}

/** One finished CI run: how long it took, where it ran, how it ended and whether it passed only on a rerun. */
export interface CiRunTime {
  kind: 'default' | 'pr'
  minutes: number
  conclusion: 'success' | 'failure'
  /** passed on a rerun: a run attempt above 1 that ended green */
  flaky: boolean
}

/** The finished workflow runs of a repo created since a date (called outside any transaction); an error names why GitHub could not be read. */
export type CiTimes = (
  repo: string,
  since: Date,
) => Promise<Result<{ runs: CiRunTime[]; truncated: boolean }, PortError>>

/** One finished workflow run as the CI ledger keeps it (`factory.ci_runs`): queued at, started at and finished at. */
export interface CiLedgerRun {
  runId: number
  workflow: string
  event: string
  headBranch: string | null
  headSha: string
  runAttempt: number
  queuedAt: Date
  startedAt: Date
  finishedAt: Date
  conclusion: string
}

/** The finished workflow runs of a repo created since a date, whatever their conclusion (called outside any transaction). */
export type CiLedgerRuns = (repo: string, since: Date) => Promise<Result<CiLedgerRun[], PortError>>

/** Whether a branch has a workflow run that is queued or in progress (called outside any transaction). */
export interface CiLive {
  running(repo: string, branch: string): Promise<Result<boolean, PortError>>
}

/**
 * The migration files of a repo at its default branch and on the refs that can still merge: every branch that is not a
 * lead's and the lead branches of the `scope` Issues (called outside any transaction).
 */
export interface MigrationFiles {
  read(repo: string, scope: { openIssues: readonly number[] }): Promise<Result<MigrationSnapshot, PortError>>
}
