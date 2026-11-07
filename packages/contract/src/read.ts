import { z } from 'zod'
import { QueueState, Quota, SessionState, Spawn, WaitOn } from './core.ts'
import { FleetAsk, FleetHealth } from './fleet.ts'
import { IssueOutcome, IssueState, WaitReason } from './issues.ts'

/**
 * The read API (`/v1`, docs/design.md §11 "The read API"): a projection of what the factory holds, shaped for people. These
 * schemas are deliberately not strict: within `/v1` a field is only ever added, so an older client ignores one it does not know.
 */

export const API_VERSION = 'v1'

export const Tokens = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
})
export type Tokens = z.infer<typeof Tokens>

/** What a piece of work took: time from the stored events, the rest from the transcripts. `partial` when a transcript could not be read. */
export const Insights = z.object({
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  elapsedMs: z.number().int(),
  /** time a turn was open, including the time it waited on background work it started; summed over an Issue's sessions */
  workingMs: z.number().int(),
  turns: z.number().int(),
  toolCalls: z.number().int(),
  subagents: z.number().int(),
  tokens: Tokens,
  models: z.array(z.string()),
  attempts: z.number().int(),
  partial: z.boolean(),
})
export type Insights = z.infer<typeof Insights>

/** Where a session runs: hc's address and name, the herdr space (keyed by the repo's real path), tab and workspace. */
export const Terminal = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  space: z.string().nullable(),
  tab: z.string().nullable(),
  workspace: z.string().nullable(),
})
export type Terminal = z.infer<typeof Terminal>

/** An account's reading, on every card that runs on one. */
export const AccountQuota = Quota.pick({
  account: true,
  fiveHourUsed: true,
  weeklyUsed: true,
  fiveHourResetsAt: true,
  weeklyResetsAt: true,
  exhaustedUntil: true,
  fresh: true,
})
export type AccountQuota = z.infer<typeof AccountQuota>

export const IssueCard = z.object({
  id: z.number().int(),
  /** the title as it was filed */
  filedTitle: z.string(),
  /** short, plain words: the digest's heading of the filed title, else the filed title cut at a word */
  title: z.string(),
  /** one sentence on where it stands */
  summary: z.string(),
  /** one sentence on what the Issue is for: the digest's answer, else the first sentence of the filed goal, else the filed title (additive) */
  about: z.string().default(''),
  state: IssueState,
  reason: WaitReason.nullable(),
  outcome: IssueOutcome.nullable(),
  /** the lead's latest phase */
  phase: z.string().nullable(),
  repo: z.string(),
  repoName: z.string(),
  /** IuRoot's: shown read-only, nothing of it goes to a model */
  visible: z.boolean(),
  kind: z.string().nullable(),
  size: z.string().nullable(),
  /** the live lead's session id */
  lead: z.string().nullable(),
  account: z.string().nullable(),
  quota: AccountQuota.nullable(),
  insights: Insights,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  /** the Issue holding the project claim this one waits behind (the lowest id if several), else null */
  heldBy: z.number().int().nullable().default(null),
  waitingOnOwner: z.boolean(),
})
export type IssueCard = z.infer<typeof IssueCard>

export const SessionCard = z.object({
  id: z.string(),
  /** the Issue it works or belongs to (a lead's, or the lead's tree) */
  issue: z.number().int().nullable(),
  /** the session that started it, when one did (additive) */
  parent: z.string().nullable().default(null),
  role: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  state: SessionState,
  wait: WaitOn.nullable(),
  account: z.string().nullable(),
  quota: AccountQuota.nullable(),
  model: z.string().nullable(),
  turn: z.number().int(),
  terminal: Terminal.nullable(),
  transcriptPath: z.string().nullable(),
  repo: z.string().nullable(),
  visible: z.boolean(),
  since: z.string().nullable(),
  lastActivityAt: z.string(),
  insights: Insights,
})
export type SessionCard = z.infer<typeof SessionCard>

export const TimelineLine = z.object({
  at: z.string(),
  kind: z.string(),
  /** plain words of what happened */
  text: z.string(),
  session: z.string().nullable(),
})
export type TimelineLine = z.infer<typeof TimelineLine>

export const EvidenceLine = z.object({
  kind: z.string(),
  link: z.string().nullable(),
  note: z.string().nullable(),
  at: z.string(),
})
export type EvidenceLine = z.infer<typeof EvidenceLine>

export const AskLine = z.object({
  question: z.string(),
  options: z.array(z.string()),
  default: z.string().nullable(),
  answer: z.string().nullable(),
  askedAt: z.string(),
})
export type AskLine = z.infer<typeof AskLine>

export const IssueDetail = IssueCard.extend({
  timeline: z.array(TimelineLine),
  evidence: z.array(EvidenceLine),
  asks: z.array(AskLine),
  sessions: z.array(SessionCard),
})
export type IssueDetail = z.infer<typeof IssueDetail>

export const IssueCards = z.object({ issues: z.array(IssueCard) })
export type IssueCards = z.infer<typeof IssueCards>

export const SessionCards = z.object({ sessions: z.array(SessionCard) })
export type SessionCards = z.infer<typeof SessionCards>

export const OverviewCounts = z.object({
  working: z.number().int(),
  waiting: z.number().int(),
  queued: z.number().int(),
  /** an Issue held for its check after a ship (additive) */
  watching: z.number().int(),
  /** the asks the factory owns (every source but the human queue): what `factory status` attention lists */
  asks: z.number().int(),
  /** the human queue's asks that are not stale (additive) */
  humanQueue: z.number().int().default(0),
  health: z.number().int(),
})
export type OverviewCounts = z.infer<typeof OverviewCounts>

/** An ask as the read API words it: `text` is one line cut at a word, `short` and `summary` are plain words without ids. */
export const ReadAsk = FleetAsk.extend({
  short: z.string(),
  summary: z.string(),
  /** the Issue it is about: from a decision or lead session id, else the Issue of its session (additive) */
  issue: z.number().int().nullable().default(null),
  /** older than 24 h */
  stale: z.boolean(),
  /** it is about a visible (IuRoot) repo or session, or names one: a surface's read token gets it redacted (additive) */
  visible: z.boolean().default(false),
})
export type ReadAsk = z.infer<typeof ReadAsk>

export const ReadHealth = FleetHealth.extend({
  short: z.string(),
  summary: z.string(),
  /** as on `ReadAsk` (additive) */
  visible: z.boolean().default(false),
})
export type ReadHealth = z.infer<typeof ReadHealth>

export const Overview = z.object({
  version: z.literal(API_VERSION),
  now: z.string(),
  /** when the fleet snapshot behind asks, health, accounts and queue was built */
  builtAt: z.string(),
  counts: OverviewCounts,
  /** the asks the factory owns */
  asks: z.array(ReadAsk),
  /** the dotfiles human queue's asks, oldest first, each with `stale` set (additive) */
  humanQueue: z.array(ReadAsk).default([]),
  health: z.array(ReadHealth),
  accounts: z.array(AccountQuota),
  queue: z.object({ effective: QueueState, spawns: z.array(Spawn) }),
})
export type Overview = z.infer<typeof Overview>

export const AskList = z.object({ asks: z.array(ReadAsk), humanQueue: z.array(ReadAsk).default([]) })
export type AskList = z.infer<typeof AskList>

export const HealthList = z.object({ health: z.array(ReadHealth) })
export type HealthList = z.infer<typeof HealthList>

export const AccountList = z.object({ accounts: z.array(AccountQuota) })
export type AccountList = z.infer<typeof AccountList>

// --- the change stream: the `data:` of each frame --------------------------------------------------------------------

/** An `issue_events` row. */
export const IssueFrame = z.object({
  issue: z.number().int(),
  kind: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  at: z.string(),
  text: z.string(),
})
export type IssueFrame = z.infer<typeof IssueFrame>

/** An `events` row of a session; `state` is what the session derives to when the frame is written. */
export const SessionFrame = z.object({
  session: z.string(),
  issue: z.number().int().nullable(),
  kind: z.string(),
  state: SessionState.nullable(),
  at: z.string(),
})
export type SessionFrame = z.infer<typeof SessionFrame>

/** The fleet snapshot moved: a hint to read the resources again. */
export const FleetFrame = z.object({ fingerprint: z.string(), builtAt: z.string() })
export type FleetFrame = z.infer<typeof FleetFrame>

export const HelloFrame = z.object({ version: z.literal(API_VERSION), cursor: z.string() })
export type HelloFrame = z.infer<typeof HelloFrame>
