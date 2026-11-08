import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { postgresLeadStore } from '../../src/adapters/leads/store.ts'
import { fileIn, recordIn } from '../../src/app/issues.ts'
import type { LeadDeps, LeadsUow } from '../../src/app/leads.ts'
import type {
  Claims,
  Repos,
  Roles,
  Seats,
  StartTerminal,
  TerminalInfo,
  Terminals,
  Transcripts,
  Windows,
  WorktreeRemoval,
  Worktrees,
} from '../../src/domains/leads/ports.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import type { Clock } from '../../src/kernel/clock.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../../src/kernel/result.ts'

export const BASE = Date.parse('2026-11-07T10:00:00Z')

/** A clock the test moves. */
export class MovingClock implements Clock {
  constructor(private at = BASE) {}
  now(): Date {
    return new Date(this.at)
  }
  advance(ms: number): void {
    this.at += ms
  }
  /** the clock stands at `seconds` after where it started */
  at_(seconds: number): void {
    this.at = BASE + seconds * 1000
  }
}

const info = (address: string, live = true): TerminalInfo => ({
  address,
  live,
  reported: true,
  status: 'idle',
  turn: 0,
  exitCode: null,
  tab: 'tb-1',
  tabName: null,
  space: 'sp-1',
})

/** Fake herdr-core: terminals by key, with the answers a test scripts. */
export class FakeTerminals implements Terminals {
  terminals = new Map<string, TerminalInfo[]>()
  started: StartTerminal[] = []
  typed: { terminal: string; text: string; force: boolean }[] = []
  closed: string[] = []
  named: { tab: string; name: string }[] = []
  startError: PortError | null = null
  typeAnswers: Result<'typed' | 'busy'>[] = []
  next = 1

  async find(k: string) {
    return ok(this.terminals.get(k) ?? [])
  }
  async start(input: StartTerminal) {
    if (this.startError) return err(this.startError)
    const existing = this.terminals.get(input.key)?.find((t) => t.live)
    if (existing) return ok(existing)
    this.started.push(input)
    const made = { ...info(`t${this.next++}`), tabName: input.tabName }
    this.terminals.set(input.key, [made])
    return ok(made)
  }
  async type(input: { terminal: string; text: string; force: boolean }) {
    this.typed.push(input)
    return this.typeAnswers.shift() ?? ok('typed' as const)
  }
  async close(k: string) {
    this.closed.push(k)
    this.terminals.delete(k)
    return ok(undefined)
  }
  async nameTab(input: { tab: string; name: string }) {
    this.named.push(input)
  }
  lose(k: string) {
    this.terminals.set(
      k,
      (this.terminals.get(k) ?? []).map((t) => ({ ...t, live: false })),
    )
  }
  reset() {
    this.terminals.clear()
    this.started = []
    this.typed = []
    this.closed = []
    this.named = []
    this.startError = null
    this.typeAnswers = []
  }
}

export class FakeWorktrees implements Worktrees {
  created: { repo: string; branch: string }[] = []
  removed: { repo: string; branch: string }[] = []
  createError: PortError | null = null
  removal: WorktreeRemoval = { removed: true }
  async create(input: { repo: string; branch: string }) {
    if (this.createError) return err(this.createError)
    this.created.push(input)
    return ok({ path: `/w/${input.branch.replace('/', '-')}`, base: 'origin/master', sha: 'a'.repeat(40) })
  }
  async remove(input: { repo: string; branch: string }) {
    this.removed.push(input)
    return ok(this.removal)
  }
  reset() {
    this.created = []
    this.removed = []
    this.createError = null
    this.removal = { removed: true }
  }
}

export interface World {
  db: TestCluster
  deps: LeadDeps
  clock: MovingClock
  terminals: FakeTerminals
  worktrees: FakeWorktrees
  claims: {
    released: { issue: IssueId; attempt: number }[]
    resumed: { issue: IssueId; attempt: number }[]
    error: PortError | null
    resumeError: PortError | null
  } & Claims
  transcripts: { archived: unknown[]; error: PortError | null } & Transcripts
  repoError: PortError | null
  seatError: PortError | null
  windowReset: Date | null
  /** files, settles and admits an Issue in the repo `example`; returns its id */
  admitted(notes?: string[]): Promise<IssueId>
  event(issue: IssueId, name: string, event: AnyIssueEvent): Promise<unknown>
  /** empties every table and every fake */
  reset(): Promise<void>
}

/** A private Postgres, the migrations, and a `LeadDeps` made of fakes: the use cases run for real against real tables. */
export async function startWorld(): Promise<World> {
  const db = await startTestCluster()
  const clock = new MovingClock()
  const terminals = new FakeTerminals()
  const worktrees = new FakeWorktrees()
  const world: World = {
    db,
    clock,
    terminals,
    worktrees,
    claims: {
      released: [],
      resumed: [],
      error: null,
      resumeError: null,
      async release(input) {
        if (this.error) return err(this.error)
        this.released.push(input)
        return ok(undefined)
      },
      async resume(input) {
        if (this.resumeError) return err(this.resumeError)
        this.resumed.push(input)
        return ok(undefined)
      },
    },
    transcripts: {
      archived: [],
      error: null,
      async archive(input) {
        if (this.error) return err(this.error)
        this.archived.push(input)
        return ok({ archived: input.sessions.length })
      },
    },
    repoError: null,
    seatError: null,
    windowReset: null,
    deps: undefined as unknown as LeadDeps,
    admitted: async () => {
      throw new Error('not ready')
    },
    event: async () => {
      throw new Error('not ready')
    },
    reset: async () => {},
  }
  const uow: LeadsUow = postgresUnitOfWork(db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    leads: postgresLeadStore(tx),
  }))
  const repos: Repos = {
    locate: async (repo) => (world.repoError ? err(world.repoError) : ok(`/roots/${repo}`)),
  }
  const roles: Roles = { lead: async () => ok({ tier: 'sonnet' as const, effort: 'high' as const }) }
  const seats: Seats = {
    seat: async () => (world.seatError ? err(world.seatError) : ok({ account: 'default' })),
  }
  const windows: Windows = { wall: async () => ok({ resetAt: world.windowReset }) }
  world.deps = {
    uow,
    clock,
    ids: sequentialIds(),
    terminals,
    worktrees,
    repos,
    roles,
    seats,
    claims: world.claims,
    windows,
    transcripts: world.transcripts,
    startBudgetMs: 30 * 60_000,
    forceNoteAfterMs: 5 * 60_000,
    graceMs: 0,
  }
  world.event = async (issue, name, event) => {
    const result = await uow.run(({ work }) =>
      recordIn(work, world.deps, { issueId: issue, key: key(issue, name), event }),
    )
    if (!result.ok) throw new Error(`event ${name}: ${JSON.stringify(result.error)}`)
    return result.value
  }
  world.admitted = async (notes = []) => {
    const filed = await uow.run(({ work }) =>
      fileIn(work, world.deps, {
        key: key('filed', world.deps.ids.next('signal')),
        event: {
          kind: 'filed',
          payload: { repo: 'example', title: 'the probe fails', kind: 'bug', origin: 'you' },
          actor: 'factory',
        },
      }),
    )
    if (!filed.ok) throw new Error(JSON.stringify(filed.error))
    const issue = filed.value.issue.id
    await world.event(issue, 'settled', { kind: 'settled', payload: {}, actor: 'factory' })
    for (const [i, text] of notes.entries()) {
      await world.event(issue, `note:${i}`, { kind: 'noted', payload: { text }, actor: 'owner' })
    }
    await world.event(issue, 'admitted:1', { kind: 'admitted', payload: {}, actor: 'factory' })
    return issue
  }
  world.reset = async () => {
    await db.sql`TRUNCATE factory.lead_attempts, factory.lead_deliveries, factory.lead_hook_events, factory.lead_sendbacks, factory.lead_finalizations, factory.issue_effect_runs, factory.issue_effects, factory.issue_events, factory.issues CASCADE`
    await db.sql`ALTER SEQUENCE factory.issue_numbers RESTART`
    terminals.reset()
    worktrees.reset()
    world.claims.released = []
    world.claims.error = null
    world.claims.resumed = []
    world.claims.resumeError = null
    world.transcripts.archived = []
    world.transcripts.error = null
    world.repoError = null
    world.seatError = null
    world.windowReset = null
    world.deps.ids = sequentialIds()
    clock.at_(0)
  }
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  return world
}
