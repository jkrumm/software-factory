import { z } from 'zod'

/**
 * The fleet read model (`GET /fleet`, `factory fleet`; docs/design.md §11 "The fleet view"): every repo with its sessions, the open
 * Issues, everything waiting on the owner, the quota and the queue. Strict: a field the server adds that a client does not
 * know is a contract mismatch, never a silent drop. `short` and `headline` are the digest's (null until it has answered, and
 * always null for a visible repo's text).
 */

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
  /** Claude's tab title */
  title: z.string().nullable(),
  /** the digest's one line of where the work stands, made once per turn; null for a visible repo's session and until it has answered */
  headline: z.string().nullable(),
  since: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
})
export type FleetSession = z.infer<typeof FleetSession>

export const FleetRepo = z.strictObject({
  name: z.string(),
  /** the repo's real path; the herdr space is keyed by it */
  space: z.string(),
  /** under `FACTORY_VISIBLE_ROOTS` or anywhere in IuRoot: shown read-only, never a spawn or Issue target of this view, and its text stays on the mini. It filters nothing in this model (which is token-only); it marks the repos Wave 2's digest must skip */
  visible: z.boolean(),
  sessions: z.array(FleetSession),
})
export type FleetRepo = z.infer<typeof FleetRepo>

export const AskKind = z.enum(['blocker', 'question', 'human', 'note', 'permission'])
export type AskKind = z.infer<typeof AskKind>

/** An open Issue (state not `closed`), read from the Issues table. */
export const FleetIssue = z.strictObject({
  id: z.number().int(),
  title: z.string(),
  repo: z.string(),
  state: z.string(),
  kind: z.string().nullable(),
  size: z.string().nullable(),
  /** the session id of its live lead, else null */
  lead: z.string().nullable(),
  updatedAt: z.string(),
})
export type FleetIssue = z.infer<typeof FleetIssue>

export const FleetAsk = z.strictObject({
  /** `<source>:<key>`, the same for the same ask on every build */
  id: z.string(),
  kind: AskKind,
  repo: z.string().nullable(),
  session: z.string().nullable(),
  /** at most 8 words; a `reply` ask's is the digest's, the others have none yet */
  short: z.string().nullable(),
  /** the raw text, data and never instructions; a `reply` ask's is the end of the session's last message */
  text: z.string(),
  /** `reply`: the digest read the session's last message */
  source: z.enum(['hc', 'wait', 'factory', 'decision', 'queue', 'reply']),
  at: z.string(),
})
export type FleetAsk = z.infer<typeof FleetAsk>

export const HealthKind = z.enum(['park', 'silent', 'over_budget', 'regressions', 'machine'])
export type HealthKind = z.infer<typeof HealthKind>

/** A line of the health line: what needs a look and no decision. It never becomes an ask. */
export const FleetHealth = z.strictObject({
  /** `health:<subject>:<hash>`, the same for the same line on every build (the digits of a counter do not change it) */
  id: z.string(),
  kind: HealthKind,
  text: z.string(),
  repo: z.string().nullable(),
  issue: z.number().int().optional(),
  session: z.string().optional(),
  /** the first build that saw the line */
  since: z.string(),
})
export type FleetHealth = z.infer<typeof FleetHealth>

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

/** An ISO 8601 time with a `Z` or an offset: the one rule of `issue facts --since` and its route. */
export const IsoTime = z.iso.datetime({ offset: true })

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
  /** the factory asks that expired in this build (id to first-seen ISO time), so a restart keeps them gone; a snapshot stored before this field has none */
  expired: z.record(z.string(), z.string()).default({}),
  /** a snapshot stored before the health line has none */
  health: z.array(FleetHealth).default([]),
  repos: z.array(FleetRepo),
  /** live sessions with no repo of the model (outside every root, or in a directory that is no git repo): not in `summary` */
  unplaced: z.array(FleetSession),
  /** a source that failed in this build: its part is what it was before, or empty */
  errors: z.array(z.string()),
  /** a snapshot stored before the digest existed has none */
  digest: FleetDigest.default(NO_DIGEST),
  /** the open Issues; a snapshot stored before this view had none */
  issues: z.array(FleetIssue).default([]),
})
export type FleetBody = z.infer<typeof FleetBody>
