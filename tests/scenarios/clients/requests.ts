import type { Caller } from '../harness.ts'

/**
 * The calls the clients of the factory make today, recorded from their own code (read-only, in ~/SourceRoot) as data:
 * who calls, where in their source, what, with which token, and the fields they read with the type they expect. The
 * replay scenario seeds a world through real flows and runs every request as the client does.
 *
 * A type is `string`, `number`, `boolean`, `array`, `object` or `null`; `a|b` allows either (a nullable field).
 * `{n}` in a call is the number of the working Issue, `{d}` the one with an open Decision.
 */
export type Fields = Record<string, string>

export interface ClientRequest {
  client: 'herdr-board' | 'hermes' | 'iris' | 'agw' | 'repo-scripts' | 'devhost-health'
  /** where the client makes the call (file:line under ~/SourceRoot) */
  source: string
  /** the call as the client writes it */
  call: string
  /** how it reaches the server */
  via: 'cli' | 'http'
  argv?: string[]
  http?: { method: 'GET' | 'POST'; path: string; headers?: Record<string, string>; body?: object }
  /** the token it holds today */
  token: Caller | 'none'
  /** the fields of the answer's root */
  root?: Fields
  /** a field that is an object: its own fields */
  nested?: Record<string, Fields>
  /** a field that is an array: the fields of its items (the array must not be empty) */
  each?: Record<string, Fields>
}

const ASK: Fields = {
  id: 'string',
  kind: 'string',
  source: 'string',
  issue: 'number|null',
  short: 'string',
  summary: 'string',
  text: 'string',
  at: 'string',
  stale: 'boolean',
  repo: 'string|null',
}

const HEALTH: Fields = {
  id: 'string',
  kind: 'string',
  short: 'string',
  summary: 'string',
  text: 'string',
  since: 'string|null',
}

const CARD: Fields = {
  id: 'number',
  ref: 'string',
  title: 'string',
  summary: 'string|null',
  about: 'string|null',
  state: 'string',
  reason: 'string|null',
  outcome: 'string|null',
  phase: 'string|null',
  repoName: 'string',
  kind: 'string|null',
  lead: 'string|null',
  account: 'string|null',
  insights: 'object',
  createdAt: 'string',
  updatedAt: 'string',
  closedAt: 'string|null',
  waitingOnOwner: 'boolean',
}

const SESSION: Fields = {
  id: 'string',
  issue: 'number|null',
  title: 'string',
  summary: 'string',
  state: 'string',
  wait: 'string|null',
  account: 'string|null',
  terminal: 'object|null',
  repo: 'string|null',
  role: 'string|null',
  since: 'string|null',
  lastActivityAt: 'string',
}

const OVERVIEW_ROOT: Fields = {
  builtAt: 'string',
  counts: 'object',
  asks: 'array',
  humanQueue: 'array',
  health: 'array',
  accounts: 'array',
  issues: 'array',
  queue: 'object',
}

const BOARD = 'dotfiles/config/herdr-app/mods/jk-board/main.js'
const HERMES_SKILL = 'hermes-agent/skills/fleet/SKILL.md'
const HERMES_OPS = 'hermes-agent/scripts/hermes-ops.sh'
const IRIS = 'iris/server/src/adapters/factory-http.ts'
const AGW = 'agent-workflows/packages/host/src/fleet/factory.ts'

export const REQUESTS: readonly ClientRequest[] = [
  // -- the Herdr board: the full token, `secrets-run` env -----------------------------------------------------------
  {
    client: 'herdr-board',
    source: `${BOARD}:32`,
    call: 'factory --format json read overview',
    via: 'cli',
    argv: ['--format', 'json', 'read', 'overview'],
    token: 'owner',
    root: OVERVIEW_ROOT,
    nested: {
      counts: {
        humanQueue: 'number',
        working: 'number',
        waiting: 'number',
        queued: 'number',
        asks: 'number',
        health: 'number',
      },
      queue: { effective: 'string' },
    },
    each: { asks: ASK, humanQueue: ASK, health: HEALTH, issues: CARD },
  },
  {
    client: 'herdr-board',
    source: `${BOARD}:32`,
    call: 'factory --format json read issues --state all --limit 40',
    via: 'cli',
    argv: ['--format', 'json', 'read', 'issues', '--state', 'all', '--limit', '40'],
    token: 'owner',
    root: { issues: 'array' },
    each: { issues: CARD },
  },
  {
    client: 'herdr-board',
    source: `${BOARD}:32`,
    call: 'factory --format json read sessions --live',
    via: 'cli',
    argv: ['--format', 'json', 'read', 'sessions', '--live'],
    token: 'owner',
    root: { sessions: 'array' },
    each: { sessions: SESSION },
  },
  {
    client: 'herdr-board',
    source: `${BOARD}:171`,
    call: 'factory --format json read issue <id>',
    via: 'cli',
    argv: ['--format', 'json', 'read', 'issue', '{n}'],
    token: 'owner',
    root: { ...CARD, timeline: 'array', sessions: 'array', asks: 'array', evidence: 'array' },
    each: { timeline: { at: 'string', kind: 'string', text: 'string' }, sessions: SESSION },
  },

  // -- Hermes: the read token only ----------------------------------------------------------------------------------
  {
    client: 'hermes',
    source: `${HERMES_SKILL}:21`,
    call: 'factory read overview',
    via: 'cli',
    argv: ['read', 'overview'],
    token: 'read',
    root: OVERVIEW_ROOT,
    each: {
      issues: { updatedAt: 'string', state: 'string', repoName: 'string', title: 'string', summary: 'string|null' },
    },
  },
  {
    client: 'hermes',
    source: `${HERMES_SKILL}:22`,
    call: 'factory read issues --limit 30',
    via: 'cli',
    argv: ['read', 'issues', '--limit', '30'],
    token: 'read',
    root: { issues: 'array' },
    each: { issues: { title: 'string', about: 'string|null', summary: 'string|null', state: 'string' } },
  },
  {
    client: 'hermes',
    source: `${HERMES_SKILL}:23`,
    call: 'factory read issue <id>',
    via: 'cli',
    argv: ['read', 'issue', '{n}'],
    token: 'read',
    root: { summary: 'string|null', timeline: 'array', asks: 'array' },
  },
  {
    client: 'hermes',
    source: `${HERMES_SKILL}:24`,
    call: 'factory read asks',
    via: 'cli',
    argv: ['read', 'asks'],
    token: 'read',
    root: { asks: 'array', humanQueue: 'array' },
    each: { asks: { short: 'string', summary: 'string', issue: 'number|null', stale: 'boolean' }, humanQueue: ASK },
  },
  {
    client: 'hermes',
    source: `${HERMES_SKILL}:25`,
    call: 'factory read sessions --live',
    via: 'cli',
    argv: ['read', 'sessions', '--live'],
    token: 'read',
    root: { sessions: 'array' },
    each: { sessions: { title: 'string', state: 'string' } },
  },
  {
    client: 'hermes',
    source: `${HERMES_OPS}:677`,
    call: 'factory read health --format json',
    via: 'cli',
    argv: ['read', 'health', '--format', 'json'],
    token: 'read',
    root: { health: 'array' },
    each: { health: { short: 'string', summary: 'string' } },
  },

  // -- Iris: HTTP with the full token ---------------------------------------------------------------------------------
  {
    client: 'iris',
    source: `${IRIS}:160`,
    call: 'GET /v1/overview',
    via: 'http',
    http: { method: 'GET', path: '/v1/overview' },
    token: 'owner',
    root: { builtAt: 'string', asks: 'array', health: 'array' },
    each: { asks: ASK, health: HEALTH },
  },
  {
    client: 'iris',
    source: `${IRIS}:169`,
    call: 'GET /v1/asks',
    via: 'http',
    http: { method: 'GET', path: '/v1/asks' },
    token: 'owner',
    root: { asks: 'array' },
    each: { asks: ASK },
  },
  {
    client: 'iris',
    source: `${IRIS}:175`,
    call: 'GET /v1/issues/{number}',
    via: 'http',
    http: { method: 'GET', path: '/v1/issues/{d}' },
    token: 'owner',
    root: { asks: 'array' },
    each: { asks: { options: 'array', answer: 'string|null', question: 'string' } },
  },

  // -- agw `agents` --------------------------------------------------------------------------------------------------
  {
    client: 'agw',
    source: `${AGW}:304`,
    call: 'factory read overview --format json',
    via: 'cli',
    argv: ['read', 'overview', '--format', 'json'],
    token: 'owner',
    root: { asks: 'array', humanQueue: 'array' },
    each: {
      asks: { id: 'string', kind: 'string', text: 'string', at: 'string' },
      humanQueue: { id: 'string', text: 'string', at: 'string' },
    },
  },
  {
    client: 'agw',
    source: `${AGW}:304`,
    call: 'factory read sessions --live --format json',
    via: 'cli',
    argv: ['read', 'sessions', '--live', '--format', 'json'],
    token: 'owner',
    root: { sessions: 'array' },
    each: { sessions: SESSION },
  },

  // -- the repo's own scripts and the devhost check -------------------------------------------------------------------
  {
    client: 'repo-scripts',
    source: 'software-factory/scripts/verify.sh:38',
    call: 'curl /health (public): .status, .version',
    via: 'http',
    http: { method: 'GET', path: '/health' },
    token: 'none',
    root: { status: 'string', version: 'string', heartbeat: 'object' },
  },
  {
    client: 'devhost-health',
    source: 'dotfiles/scripts/devhost-health-check.sh:1313',
    call: 'curl /health (public): .heartbeat.ok|reason|tickAt|queueMovedAt',
    via: 'http',
    http: { method: 'GET', path: '/health' },
    token: 'none',
    root: { heartbeat: 'object' },
    nested: { heartbeat: { ok: 'boolean', reason: 'string|null', tickAt: 'string|null', queueMovedAt: 'string|null' } },
  },
]

/** The legacy commands that are retired, with the word their hint must carry. */
export const RETIRED: readonly { client: string; source: string; argv: string[]; hint: string }[] = [
  {
    client: 'herdr-board',
    source: `${BOARD}:39`,
    argv: ['--format', 'json', 'fleet', '--refresh'],
    hint: 'factory read overview',
  },
  {
    client: 'repo-scripts',
    source: 'software-factory/scripts/verify.sh:73',
    argv: ['spawn', 'list'],
    hint: 'factory signal file',
  },
]
