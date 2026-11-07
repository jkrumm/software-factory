import * as z from 'zod'

/**
 * The read API (`/v1`): a projection of what the factory holds, shaped for people, and the change stream. Existing clients
 * (Hermes, Iris, the Herdr board, agw) read these shapes, so within `/v1` a field is only ever added. The schemas are
 * deliberately not strict: an older client ignores a field it does not know.
 *
 * Mapping to the language (`docs/language.md`): an **ask** is what waits on the owner that is a Decision or an artifact
 * awaiting a verdict; the **human queue** is the open Errands; a **session** is one lead attempt, its id the lead key
 * `lead-<n>-<attempt>`; an Issue is `issue_<n>`, with the number kept as `id` and the full id as `ref`.
 */

export const READ_API_VERSION = 'v1'

const iso = z.string()

export const READ_ISSUE_STATES = ['settling', 'queued', 'working', 'waiting', 'watching', 'closed'] as const
/** Legacy session words; `dead` is a lead that is gone, `walled` one stopped at its account's limit. */
export const READ_SESSION_STATES = [
  'starting',
  'working',
  'idle',
  'waiting',
  'walled',
  'blocked',
  'stuck',
  'dead',
] as const

export const ReadInsights = z
  .object({
    startedAt: iso,
    endedAt: iso.nullable(),
    elapsedMs: z.number().int(),
    /** time a turn was open, summed over an Issue's attempts */
    workingMs: z.number().int(),
    turns: z.number().int(),
    /** zero until the usage schema is joined (the KPI read) */
    toolCalls: z.number().int(),
    subagents: z.number().int(),
    tokens: z.object({
      input: z.number().int(),
      output: z.number().int(),
      cacheRead: z.number().int(),
      cacheWrite: z.number().int(),
    }),
    models: z.array(z.string()),
    attempts: z.number().int(),
    /** true while tool calls, subagents and tokens are not yet counted */
    partial: z.boolean(),
  })
  .meta({ id: 'ReadInsights' })
export type ReadInsights = z.infer<typeof ReadInsights>

export const ReadTerminal = z
  .object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    space: z.string().nullable(),
    tab: z.string().nullable(),
    workspace: z.string().nullable(),
  })
  .meta({ id: 'ReadTerminal' })
export type ReadTerminal = z.infer<typeof ReadTerminal>

/** An account's reading, on every card that runs on one. */
export const ReadAccountQuota = z
  .object({
    account: z.string(),
    fiveHourUsed: z.number().nullable(),
    weeklyUsed: z.number().nullable(),
    fiveHourResetsAt: iso.nullable(),
    weeklyResetsAt: iso.nullable(),
    exhaustedUntil: iso.nullable(),
    fresh: z.boolean(),
  })
  .meta({ id: 'ReadAccountQuota' })
export type ReadAccountQuota = z.infer<typeof ReadAccountQuota>

export const ReadIssueCard = z
  .object({
    /** the Issue's number */
    id: z.number().int(),
    /** `issue_<n>` */
    ref: z.string(),
    /** the title as it was filed */
    filedTitle: z.string(),
    /** short, plain words: the filed title cut at a word, no ids */
    title: z.string(),
    /** one plain sentence on where it stands; null when nothing is known */
    summary: z.string().nullable(),
    /** one plain sentence on what the Issue is for */
    about: z.string().nullable(),
    state: z.enum(READ_ISSUE_STATES),
    /** the wait's name while `waiting` (timer, dependency, decision, review ...) */
    reason: z.string().nullable(),
    outcome: z.string().nullable(),
    /** a plain word for what the Issue is doing now ("building", "waiting for your answer") */
    phase: z.string().nullable(),
    repo: z.string(),
    repoName: z.string(),
    /** a work repo's: shown read-only, nothing of its text goes to the read token */
    visible: z.boolean(),
    kind: z.string().nullable(),
    size: z.string().nullable(),
    /** the live lead's key */
    lead: z.string().nullable(),
    account: z.string().nullable(),
    quota: ReadAccountQuota.nullable(),
    insights: ReadInsights,
    createdAt: iso,
    updatedAt: iso,
    closedAt: iso.nullable(),
    /** the Issue holding the repo claim this one waits behind, when it is known */
    heldBy: z.number().int().nullable(),
    waitingOnOwner: z.boolean(),
  })
  .meta({ id: 'ReadIssueCard' })
export type ReadIssueCard = z.infer<typeof ReadIssueCard>

export const ReadSessionCard = z
  .object({
    /** the lead key `lead-<n>-<attempt>` */
    id: z.string(),
    issue: z.number().int().nullable(),
    issueRef: z.string().nullable(),
    parent: z.string().nullable(),
    role: z.string().nullable(),
    title: z.string(),
    summary: z.string(),
    state: z.enum(READ_SESSION_STATES),
    /** the board's word for `state` */
    status: z.enum(READ_SESSION_STATES),
    wait: z.string().nullable(),
    account: z.string().nullable(),
    quota: ReadAccountQuota.nullable(),
    model: z.string().nullable(),
    turn: z.number().int(),
    terminal: ReadTerminal.nullable(),
    /** the terminal's address and tab, flat, as the board reads them */
    address: z.string().nullable(),
    tab: z.string().nullable(),
    transcriptPath: z.string().nullable(),
    repo: z.string().nullable(),
    visible: z.boolean(),
    since: iso.nullable(),
    lastActivityAt: iso,
    insights: ReadInsights,
  })
  .meta({ id: 'ReadSessionCard' })
export type ReadSessionCard = z.infer<typeof ReadSessionCard>

export const ReadTimelineLine = z
  .object({
    at: iso,
    kind: z.string(),
    /** plain words of what happened */
    text: z.string(),
    session: z.string().nullable(),
  })
  .meta({ id: 'ReadTimelineLine' })
export type ReadTimelineLine = z.infer<typeof ReadTimelineLine>

export const ReadEvidenceLine = z
  .object({
    kind: z.string(),
    link: z.string().nullable(),
    note: z.string().nullable(),
    at: iso,
  })
  .meta({ id: 'ReadEvidenceLine' })
export type ReadEvidenceLine = z.infer<typeof ReadEvidenceLine>

export const ReadAskLine = z
  .object({
    question: z.string(),
    options: z.array(z.string()),
    default: z.string().nullable(),
    answer: z.string().nullable(),
    askedAt: iso,
  })
  .meta({ id: 'ReadAskLine' })
export type ReadAskLine = z.infer<typeof ReadAskLine>

export const ReadIssueDetail = ReadIssueCard.extend({
  timeline: z.array(ReadTimelineLine),
  evidence: z.array(ReadEvidenceLine),
  asks: z.array(ReadAskLine),
  sessions: z.array(ReadSessionCard),
}).meta({ id: 'ReadIssueDetail' })
export type ReadIssueDetail = z.infer<typeof ReadIssueDetail>

export const ReadIssueCards = z.object({ issues: z.array(ReadIssueCard) }).meta({ id: 'ReadIssueCards' })
export type ReadIssueCards = z.infer<typeof ReadIssueCards>

export const ReadSessionCards = z.object({ sessions: z.array(ReadSessionCard) }).meta({ id: 'ReadSessionCards' })
export type ReadSessionCards = z.infer<typeof ReadSessionCards>

export const ReadOverviewCounts = z
  .object({
    working: z.number().int(),
    waiting: z.number().int(),
    queued: z.number().int(),
    watching: z.number().int(),
    /** what waits on the owner: Decisions and artifacts awaiting a verdict */
    asks: z.number().int(),
    /** open Errands that are not stale */
    humanQueue: z.number().int(),
    health: z.number().int(),
  })
  .meta({ id: 'ReadOverviewCounts' })
export type ReadOverviewCounts = z.infer<typeof ReadOverviewCounts>

/** An ask or an Errand as the read API words it: `text` is one line cut at a word, `short` and `summary` are plain words without ids. */
export const ReadAsk = z
  .object({
    /** the Decision's, artifact's or Errand's id */
    id: z.string(),
    /** decision, review or errand */
    kind: z.string(),
    source: z.string(),
    /** the Issue's number */
    issue: z.number().int().nullable(),
    issueRef: z.string().nullable(),
    short: z.string(),
    summary: z.string(),
    text: z.string(),
    at: iso,
    /** older than 24 h */
    stale: z.boolean(),
    repo: z.string().nullable(),
    session: z.string().nullable(),
    /** a work repo's: the read token gets it redacted */
    visible: z.boolean(),
  })
  .meta({ id: 'ReadAsk' })
export type ReadAsk = z.infer<typeof ReadAsk>

export const ReadHealthLine = z
  .object({
    id: z.string(),
    kind: z.string(),
    short: z.string(),
    summary: z.string(),
    text: z.string(),
    since: iso.nullable(),
    repo: z.string().nullable(),
    visible: z.boolean(),
  })
  .meta({ id: 'ReadHealthLine' })
export type ReadHealthLine = z.infer<typeof ReadHealthLine>

export const ReadOverview = z
  .object({
    version: z.literal(READ_API_VERSION),
    now: iso,
    /** when the figures behind asks, health, accounts and queue were read (now: they are read per request) */
    builtAt: iso,
    counts: ReadOverviewCounts,
    asks: z.array(ReadAsk),
    humanQueue: z.array(ReadAsk),
    health: z.array(ReadHealthLine),
    accounts: z.array(ReadAccountQuota),
    /** the open Issues, newest activity first */
    issues: z.array(ReadIssueCard),
    /** `effective` is the whole queue's state; `spawns` stays empty (a lead's start is not a queue row any more); `projects` are the per-project states */
    queue: z.object({
      effective: z.enum(['run', 'pace', 'drain']),
      spawns: z.array(z.unknown()),
      projects: z.record(z.string(), z.enum(['run', 'pace', 'drain'])),
    }),
  })
  .meta({ id: 'ReadOverview' })
export type ReadOverview = z.infer<typeof ReadOverview>

export const ReadAskList = z
  .object({ asks: z.array(ReadAsk), humanQueue: z.array(ReadAsk) })
  .meta({ id: 'ReadAskList' })
export type ReadAskList = z.infer<typeof ReadAskList>

export const ReadHealthList = z.object({ health: z.array(ReadHealthLine) }).meta({ id: 'ReadHealthList' })
export type ReadHealthList = z.infer<typeof ReadHealthList>

export const ReadAccountList = z.object({ accounts: z.array(ReadAccountQuota) }).meta({ id: 'ReadAccountList' })
export type ReadAccountList = z.infer<typeof ReadAccountList>

// --- the change stream -------------------------------------------------------------------------------------------------

export const CHANGE_KINDS = ['issue', 'session', 'decision', 'artifact', 'errand', 'signal'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** The `data:` of one frame and one entry of `GET /v1/changes`: kinds, ids and states, never an Issue's text. */
export const ReadChange = z
  .object({
    /** the cursor that resumes after this change */
    cursor: z.string(),
    kind: z.enum(CHANGE_KINDS),
    issue: z.number().int().nullable(),
    ref: z.string().nullable(),
    subject: z.string().nullable(),
    detail: z.record(z.string(), z.unknown()),
    at: iso,
  })
  .meta({ id: 'ReadChange' })
export type ReadChange = z.infer<typeof ReadChange>

/** `GET /v1/changes`: the changes after a cursor and the cursor to ask with next (the one given, when there are none). */
export const ChangeList = z.object({ changes: z.array(ReadChange), cursor: z.string() }).meta({ id: 'ChangeList' })
export type ChangeList = z.infer<typeof ChangeList>

/** The first frame of a stream: the cursor it starts from. */
export const StreamHello = z
  .object({ version: z.literal(READ_API_VERSION), cursor: z.string() })
  .meta({ id: 'StreamHello' })
export type StreamHello = z.infer<typeof StreamHello>
