import { z } from 'zod'

/**
 * The fleet read model (`GET /fleet`, `factory fleet`; docs/design.md §11 "The fleet view"): every repo with its plan and
 * sessions, everything waiting on the owner, the quota and the queue. Strict: a field the server adds that a client does not
 * know is a contract mismatch, never a silent drop. `short` and `headline` are the digest's (Wave 2; null until it has answered, and
 * always null for a visible repo's text); `tier`, `suggestion`, `actions` and `folded` are the triage's (Wave 3, `src/fleet/triage.ts`).
 */

export const PlanState = z.enum(['running', 'planned', 'scheduled', 'stale', 'done'])
export type PlanState = z.infer<typeof PlanState>

/** `done`, `active`, `pending`, `scheduled` (also written `later`); any other word in a status comment reads as `unknown`. */
export const WaveStatus = z.enum(['done', 'active', 'pending', 'scheduled', 'unknown'])
export type WaveStatus = z.infer<typeof WaveStatus>

export const FleetWave = z.strictObject({
  n: z.number().int(),
  title: z.string(),
  /** the heading's `<!-- short: … -->`; else for a visible (IuRoot) repo the title cut at 8 words; else the digest's, once made */
  short: z.string().nullable(),
  status: WaveStatus,
  /** `<!-- status: done 2026-11-01, release … -->`: the date, and what follows it */
  statusDate: z.string().nullable(),
  statusText: z.string().nullable(),
})
export type FleetWave = z.infer<typeof FleetWave>

export const FleetPlan = z.strictObject({
  /** the real path of the plan file */
  path: z.string(),
  /** sha-256 of the file's bytes, 12 hex */
  sha: z.string(),
  title: z.string(),
  /** the title's `<!-- short: … -->`; for a visible (IuRoot) repo the title cut at 8 words; else the digest's, once made */
  short: z.string().nullable(),
  goal: z.string().nullable(),
  waves: z.array(FleetWave),
  state: PlanState,
  /** the plan file's last commit; the file's mtime for one git does not know */
  lastTouched: z.string().nullable(),
})
export type FleetPlan = z.infer<typeof FleetPlan>

export const FleetSession = z.strictObject({
  /** the factory's session id and the hc terminal's name when they are the same agent; else whichever there is */
  id: z.string(),
  role: z.string().nullable(),
  parent: z.string().nullable(),
  /** the factory's derived state; for a terminal the factory does not know, hc's status mapped on it */
  state: z.enum(['starting', 'working', 'idle', 'waiting', 'walled', 'blocked', 'stuck']),
  /** hc's own word (`working`, `idle`, `done`, `blocked`), when hc has the terminal */
  hc: z.string().nullable(),
  wait: z.enum(['workers', 'deploy', 'owner']).nullable(),
  account: z.string().nullable(),
  /** hc's address, `t7d` */
  terminal: z.string().nullable(),
  /** the plan file it works (its spawn's prompt names it, else the plan above its directory, else the repo's) */
  plan: z.string().nullable(),
  /** the wave of that plan its spawn's prompt names */
  wave: z.number().int().nullable(),
  /** Claude's tab title */
  title: z.string().nullable(),
  /** the digest's one line of where the work stands, made once per turn; null for a visible repo's session and until it has answered */
  headline: z.string().nullable(),
  since: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
})
export type FleetSession = z.infer<typeof FleetSession>

export const FleetCommit = z.strictObject({ sha: z.string(), subject: z.string(), at: z.string() })
export type FleetCommit = z.infer<typeof FleetCommit>

export const FleetGit = z.strictObject({
  branch: z.string().nullable(),
  dirty: z.boolean(),
  lastCommit: FleetCommit.nullable(),
  /** the last 20 commits of the default branch, first-parent, newest first (FV Wave 4: what `GET /fleet/since` calls shipped); a snapshot an older release stored has none */
  recent: z.array(FleetCommit).default([]),
})
export type FleetGit = z.infer<typeof FleetGit>

export const FleetRepo = z.strictObject({
  name: z.string(),
  /** the repo's real path; the herdr space is keyed by it */
  space: z.string(),
  /** under `FACTORY_VISIBLE_ROOTS` or anywhere in IuRoot: shown read-only, never a spawn or Issue target of this view, and its text stays on the mini. It filters nothing in this model (which is token-only); it marks the repos Wave 2's digest must skip */
  visible: z.boolean(),
  git: FleetGit.nullable(),
  /** the plan a live session works, else the repo's `docs/waves/PLAN.md`, else the first one a spawn names */
  plan: FleetPlan.nullable(),
  /** the other plans of the repo that a live session works or a spawn names (the teamchat case) */
  morePlans: z.array(FleetPlan),
  sessions: z.array(FleetSession),
})
export type FleetRepo = z.infer<typeof FleetRepo>

export const AskKind = z.enum(['blocker', 'question', 'human', 'note', 'permission'])
export type AskKind = z.infer<typeof AskKind>

/**
 * Who deals with an ask (docs/design.md §11 "The fleet view", Wave 3): `automatic` is bookkeeping the triage did and logged (an ask
 * of that tier is not listed, its log row is); `one_click` has a suggestion with evidence; `hand_off` starts work instead of deciding;
 * `yours` is the business classes and anything that needs the owner at a machine (only Later, and Deny where the source can be denied).
 */
export const AskTier = z.enum(['automatic', 'one_click', 'hand_off', 'yours'])
export type AskTier = z.infer<typeof AskTier>

/** What can be done with an ask (`POST /fleet/asks/:id/act`). */
export const ActIntent = z.enum(['resolve', 'deny', 'later', 'archive_plan', 'hand_off'])
export type ActIntent = z.infer<typeof ActIntent>

export const FleetSuggestion = z.strictObject({
  /** an intent the ask offers */
  verb: ActIntent,
  why: z.string(),
  /** what was looked at: a probe's answer, a date, a count. A suggestion without evidence is not made. */
  evidence: z.string().min(1),
  /** 0 to 1 */
  confidence: z.number().min(0).max(1),
})
export type FleetSuggestion = z.infer<typeof FleetSuggestion>

export const FleetAsk = z.strictObject({
  /** `<source>:<key>`, the same for the same ask on every build */
  id: z.string(),
  kind: AskKind,
  repo: z.string().nullable(),
  session: z.string().nullable(),
  /** the plan file of the session it concerns */
  plan: z.string().nullable(),
  /** at most 8 words; a `reply` ask's is the digest's, the others have none yet */
  short: z.string().nullable(),
  /** the raw text, data and never instructions; a `reply` ask's is the end of the session's last message */
  text: z.string(),
  /** `reply`: the digest read the session's last message; `handoff`: a hand-off's worker ended (the result of work an ask started; one that failed to start is the factory's `spawn … failed` ask) */
  source: z.enum(['hc', 'wait', 'factory', 'decision', 'queue', 'reply', 'handoff']),
  at: z.string(),
  /** the triage's tier (Wave 3), by deterministic rules; the digest never sets or moves it. A snapshot an older release stored has none: `yours` */
  tier: AskTier.default('yours'),
  suggestion: FleetSuggestion.nullable(),
  actions: z.array(z.strictObject({ label: z.string(), intent: ActIntent })),
  /** the ids of older asks the triage folded under this one (`fleet_triage_log`, undoable) */
  folded: z.array(z.string()).default([]),
  /**
   * Which time the ask has been raised: an ask that leaves its source for a build ends its occurrence, and a return is a new one (1 again
   * is never reused). What the owner did with an ask (a close, a snooze) is of one occurrence.
   */
  occurrence: z.number().int().positive().default(1),
})
export type FleetAsk = z.infer<typeof FleetAsk>

export const FleetSummary = z.strictObject({
  /** the sessions listed under a repo, `working` or `starting`; the three counts do not overlap */
  working: z.number().int(),
  /** alive and neither working nor done: idle, waiting, blocked, stuck, walled */
  idle: z.number().int(),
  /** not working, and hc says `done`: the turn ended and the owner has not looked */
  done: z.number().int(),
  asks: z.number().int(),
  /** asks older than 24 h */
  staleAsks: z.number().int(),
})
export type FleetSummary = z.infer<typeof FleetSummary>

/** Where the owner is: the Herdr app on the MacBook, or Iris on the phone. */
export const PresencePlace = z.enum(['desk', 'phone'])
export type PresencePlace = z.infer<typeof PresencePlace>

/** What only a person does (FV Wave 4); never a hook event, a prompt, a note, `rd say` or HID idle. `memo` and `foreground` are the phone's only. */
export const PRESENCE_ACTS = ['focus', 'looked', 'board_click', 'unlock', 'memo', 'foreground', 'caught_up'] as const
export const PresenceAct = z.enum(PRESENCE_ACTS)
export type PresenceAct = z.infer<typeof PresenceAct>

/** An ISO 8601 time with a `Z` or an offset: the one rule of `GET /fleet/since?t=`, `until` and the CLI's `--t`. */
export const IsoTime = z.iso.datetime({ offset: true })

/**
 * `caught_up` takes the `until` of the since reading the owner saw: the cursor moves there (at most to now), so an item that landed after that
 * reading stays in the next window. Any other act has no `until`.
 */
export const PresenceBody = z
  .strictObject({ place: PresencePlace, act: PresenceAct, until: IsoTime.optional() })
  .refine((b) => b.place === 'phone' || (b.act !== 'memo' && b.act !== 'foreground'), {
    message: 'memo and foreground are the phone only',
  })
  .refine((b) => (b.act === 'caught_up') === (b.until !== undefined), {
    message: 'caught_up takes the until of the reading that was seen, and no other act does',
  })
export type PresenceBody = z.infer<typeof PresenceBody>

export const PlacePresence = z.strictObject({
  /** the newest act at this place; null before the first */
  at: z.string().nullable(),
  /** derived by the clock, never stored: the desk while its last act is under 45 min old, the phone under 10 min */
  present: z.boolean(),
})
export type PlacePresence = z.infer<typeof PlacePresence>

export const Presence = z.strictObject({
  desk: PlacePresence,
  phone: PlacePresence,
  /** neither place is present (also before any act: until the board reports, the owner is away) */
  away: z.boolean(),
  /** when presence ran out; null while present and before any act */
  awaySince: z.string().nullable(),
  /** the owner-wide cursor: moves on `caught_up` and on the act that leaves nothing else open; never backwards */
  seenAt: z.string().nullable(),
})
export type Presence = z.infer<typeof Presence>

export const ActBody = z.strictObject({
  intent: ActIntent,
  /** where the owner acts from (a presence act is recorded for it); default `desk` */
  place: PresencePlace.optional(),
  /** the owner's words: goes to the queue's `--note`, a decision's denial, the hand-off's brief */
  note: z.string().trim().min(1).max(2000).optional(),
  /** `later`: when the ask comes back (an ISO time, at most 30 days ahead); default 24 h */
  until: z.iso.datetime().optional(),
})
export type ActBody = z.infer<typeof ActBody>

export const ActResult = z.strictObject({
  ask: z.string(),
  intent: ActIntent,
  /** the same act again is answered with the first one's result */
  duplicate: z.boolean(),
  /** one line of what happened */
  detail: z.string(),
  /** `hand_off`, `archive_plan`: the spawn that was queued */
  spawn: z.string().nullable(),
  /** `later`: when the ask comes back */
  until: z.string().nullable(),
})
export type ActResult = z.infer<typeof ActResult>

export const TriageKind = z.enum(['plan_stale', 'fold', 'dismiss_note'])
export type TriageKind = z.infer<typeof TriageKind>

/** One row of `factory.fleet_triage_log`: bookkeeping the triage did on its own. It never runs a command and never denies. */
export const TriageEntry = z.strictObject({
  id: z.number().int(),
  kind: TriageKind,
  /** a plan path or an ask id */
  subject: z.string(),
  what: z.string(),
  why: z.string(),
  evidence: z.string(),
  at: z.string(),
  undoneAt: z.string().nullable(),
})
export type TriageEntry = z.infer<typeof TriageEntry>

export const TriageList = z.strictObject({ entries: z.array(TriageEntry) })
export type TriageList = z.infer<typeof TriageList>

/** One UTC day of the digest's calls (`factory.fleet_digest_runs`). */
export const FleetDigestDay = z.strictObject({
  /** `YYYY-MM-DD`, UTC */
  day: z.string(),
  /** `agw digest` calls made, failed ones included */
  calls: z.number().int(),
  failed: z.number().int(),
  /** items sent */
  items: z.number().int(),
  /** what agw said the calls cost */
  costUsd: z.number(),
})
export type FleetDigestDay = z.infer<typeof FleetDigestDay>

/** The digest's own state: whether it runs, the spend per day (newest first, the last 7 days with a call), the last failure. Not in the fingerprint. */
export const FleetDigest = z.strictObject({
  enabled: z.boolean(),
  /** a run `agw` has not finished is being waited for: no new call is made until it ends (not a failure) */
  pending: z.boolean().default(false),
  lastAt: z.string().nullable(),
  lastError: z.string().nullable(),
  days: z.array(FleetDigestDay),
})
export type FleetDigest = z.infer<typeof FleetDigest>

export const NO_DIGEST: FleetDigest = { enabled: false, pending: false, lastAt: null, lastError: null, days: [] }

/**
 * Everything of the model but the quota and the queue, which are `factory status`'s own shapes and live beside them in
 * `index.ts` (`Fleet = FleetBody + quota + queue`).
 */
export const FleetBody = z.strictObject({
  /** when the builder read the sources */
  builtAt: z.string(),
  /** of the model without the clock-driven fields; what `NOTIFY fleet` carries */
  fingerprint: z.string(),
  summary: FleetSummary,
  asks: z.array(FleetAsk),
  repos: z.array(FleetRepo),
  /** live sessions with no repo of the model (outside every root, or in a directory that is no git repo): not in `summary` */
  unplaced: z.array(FleetSession),
  /** a source that failed in this build: its part is what it was before, or empty */
  errors: z.array(z.string()),
  /** a snapshot stored before the digest existed has none */
  digest: FleetDigest.default(NO_DIGEST),
})
export type FleetBody = z.infer<typeof FleetBody>

// --- GET /fleet/since (FV Wave 4) ------------------------------------------------------------------------------------

/**
 * Every line of the since reading names the fact it comes from (`source`: `table:key`, or `git:<repo>@<sha>`), so the gate can trace it.
 * `visible` marks an IuRoot (read-only, never leaves the mini) item: its text is shown here, on the token API, and is only ever a count
 * in the headline's input and in the morning message.
 */
const lineBase = {
  text: z.string(),
  at: z.string().nullable(),
  repo: z.string().nullable(),
  visible: z.boolean(),
  source: z.string(),
}

export const SinceAsk = z.strictObject({
  ask: FleetAsk,
  /** the `yours` tier: listed first */
  yours: z.boolean(),
  visible: z.boolean(),
  source: z.string(),
})
export type SinceAsk = z.infer<typeof SinceAsk>

export const SinceShipped = z.strictObject({ kind: z.enum(['issue', 'commit', 'wave']), ...lineBase })
export type SinceShipped = z.infer<typeof SinceShipped>

export const SinceRecovered = z.strictObject({
  kind: z.enum(['spawn', 'effect', 'notification', 'digest']),
  ...lineBase,
})
export type SinceRecovered = z.infer<typeof SinceRecovered>

export const SinceHandled = z.strictObject({
  kind: z.enum(['triage', 'act']),
  ...lineBase,
  /** a triage row that is not undone yet: `POST /fleet/triage/:id/undo` */
  undoId: z.number().int().nullable(),
})
export type SinceHandled = z.infer<typeof SinceHandled>

export const SinceRunning = z.strictObject({
  kind: z.literal('session'),
  ...lineBase,
  id: z.string(),
  headline: z.string().nullable(),
  /** since its `session_started` event; null for a terminal only hc knows */
  ranForMs: z.number().int().nullable(),
})
export type SinceRunning = z.infer<typeof SinceRunning>

export const SinceSpend = z.strictObject({
  accounts: z.array(
    z.strictObject({
      account: z.string(),
      /** the weekly share used at the window's start: the nearest reading at or before it */
      weeklyAtStart: z.number().nullable(),
      weeklyNow: z.number().nullable(),
      source: z.string(),
    }),
  ),
  /** what the digest's own `agw` calls cost in the window */
  digestUsd: z.number(),
  digestSource: z.string(),
})
export type SinceSpend = z.infer<typeof SinceSpend>

/** `none`: nothing to say or no digest; `pending`: queued, in flight or waiting; `failed`: its last call failed (the groups stand without it). */
export const HeadlineState = z.enum(['ready', 'pending', 'failed', 'none'])
export type HeadlineState = z.infer<typeof HeadlineState>

export const SinceHeadline = z.strictObject({ state: HeadlineState, text: z.string().nullable() })
export type SinceHeadline = z.infer<typeof SinceHeadline>

export const Since = z.strictObject({
  /** the window's start as used (a request's `t` older than 7 days is cut to 7 days) */
  t: z.string(),
  until: z.string(),
  clamped: z.boolean(),
  seenAt: z.string().nullable(),
  headline: SinceHeadline,
  needsYou: z.array(SinceAsk),
  shipped: z.array(SinceShipped),
  recovered: z.array(SinceRecovered),
  handled: z.array(SinceHandled),
  running: z.array(SinceRunning),
  spend: SinceSpend,
})
export type Since = z.infer<typeof Since>
