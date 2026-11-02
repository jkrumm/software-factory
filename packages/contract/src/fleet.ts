import { z } from 'zod'

/**
 * The fleet read model (`GET /fleet`, `factory fleet`; docs/design.md §11 "The fleet view"): every repo with its plan and
 * sessions, everything waiting on the owner, the quota and the queue. Strict: a field the server adds that a client does not
 * know is a contract mismatch, never a silent drop. `short`, `headline`, `suggestion` and `actions` are the digest's and the
 * triage's (later waves): they exist and are empty here.
 */

export const PlanState = z.enum(['running', 'planned', 'scheduled', 'stale', 'done'])
export type PlanState = z.infer<typeof PlanState>

/** `done`, `active`, `pending`, `scheduled` (also written `later`); any other word in a status comment reads as `unknown`. */
export const WaveStatus = z.enum(['done', 'active', 'pending', 'scheduled', 'unknown'])
export type WaveStatus = z.infer<typeof WaveStatus>

export const FleetWave = z.strictObject({
  n: z.number().int(),
  title: z.string(),
  /** the heading's `<!-- short: … -->`; for a visible (IuRoot) repo the title cut at 8 words when there is none; else null */
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
  headline: z.string().nullable(),
  since: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
})
export type FleetSession = z.infer<typeof FleetSession>

export const FleetGit = z.strictObject({
  branch: z.string().nullable(),
  dirty: z.boolean(),
  lastCommit: z.strictObject({ sha: z.string(), subject: z.string(), at: z.string() }).nullable(),
})
export type FleetGit = z.infer<typeof FleetGit>

export const FleetRepo = z.strictObject({
  name: z.string(),
  /** the repo's real path; the herdr space is keyed by it */
  space: z.string(),
  /** under `FACTORY_VISIBLE_ROOTS` or anywhere in IuRoot: shown read-only, never a spawn or Issue target of this view, and its text stays on the mini */
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

export const FleetAsk = z.strictObject({
  /** `<source>:<key>`, the same for the same ask on every build */
  id: z.string(),
  kind: AskKind,
  repo: z.string().nullable(),
  session: z.string().nullable(),
  /** the plan file of the session it concerns */
  plan: z.string().nullable(),
  short: z.string().nullable(),
  /** the raw text, data and never instructions */
  text: z.string(),
  source: z.enum(['hc', 'wait', 'factory', 'decision', 'queue']),
  at: z.string(),
  suggestion: z
    .strictObject({ verb: z.string(), why: z.string(), evidence: z.string(), confidence: z.number() })
    .nullable(),
  actions: z.array(z.strictObject({ label: z.string(), intent: z.string() })),
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
})
export type FleetBody = z.infer<typeof FleetBody>
