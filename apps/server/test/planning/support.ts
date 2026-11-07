import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { postgresCapacityStore } from '../../src/adapters/postgres/capacity-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresPlanningStore } from '../../src/adapters/postgres/planning-store.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import type { CapacityDeps } from '../../src/app/capacity-admit.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import type { SyncDeps } from '../../src/app/planning-sync.ts'
import type { AccountReading } from '../../src/domains/capacity/accounts.ts'
import type { MemoryReading } from '../../src/domains/capacity/host.ts'
import type { AccountSource, HostReader } from '../../src/domains/capacity/ports.ts'
import type { ProjectSource, RepoRef } from '../../src/domains/planning/ports.ts'
import type { RepoRead } from '../../src/domains/planning/sync.ts'
import type { AnyIssueEvent, EventKind, IssueEvent } from '../../src/domains/work/events.ts'
import { type FixedClock, fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'
import { readIssues } from '../../src/read/planning.ts'
import type { Actor } from '../../src/kernel/events.ts'

export const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

/** Repos the fake source knows, and what their default branches say; a test edits `files` and the next read sees it. */
export class FakeSource implements ProjectSource {
  repos = new Map<string, { ref: RepoRef; read: RepoRead | 'fail' }>()
  reads: string[] = []

  add(directory: string, read: Partial<RepoRead> = {}): RepoRef {
    const ref = { directory, path: `/src/${directory}` }
    this.repos.set(ref.path, {
      ref,
      read: { branch: 'origin/main', project: { state: 'absent' }, plan: { state: 'absent' }, ...read },
    })
    return ref
  }

  set(directory: string, read: Partial<RepoRead>): void {
    const entry = this.repos.get(`/src/${directory}`)
    if (!entry || entry.read === 'fail') throw new Error(`no repo ${directory}`)
    entry.read = { ...entry.read, ...read }
  }

  async discover() {
    return ok(
      [...this.repos.values()].filter((e) => e.read !== 'fail' && e.read.project.state !== 'absent').map((e) => e.ref),
    )
  }

  async resolve(repo: string) {
    const hit = [...this.repos.values()].find((e) => e.ref.path === repo || e.ref.directory === repo)
    return ok(hit?.ref ?? null)
  }

  async read(repo: RepoRef) {
    this.reads.push(repo.path)
    const entry = this.repos.get(repo.path)
    if (!entry || entry.read === 'fail') return err(portError('gone', `${repo.path}: cannot be read`))
    return ok(entry.read)
  }
}

export class FakeHost implements HostReader {
  loadValue: Result<number> = ok(1)
  memoryValue: Result<MemoryReading> = ok({ swapoutMbPer300s: 0, swapUsedPct: 10 })
  async load() {
    return this.loadValue
  }
  async memory() {
    return this.memoryValue
  }
}

export class FakeAccounts implements AccountSource {
  rows: Omit<AccountReading, 'readAt' | 'sampledAt'>[] = []
  fail = false
  reads = 0
  async read(at: Date) {
    this.reads++
    if (this.fail) return err(portError('gone', 'the picker is not installed'))
    return ok(this.rows.map((row) => ({ ...row, readAt: at, sampledAt: new Date(at.getTime() - 30_000) })))
  }
}

export const account = (
  name: string,
  extra: Partial<AccountReading> = {},
): Omit<AccountReading, 'readAt' | 'sampledAt'> => ({
  account: name,
  enabled: true,
  authOk: true,
  fiveHourUsed: 10,
  weeklyUsed: 20,
  fiveHourResetsAt: new Date('2026-11-07T15:00:00Z'),
  weeklyResetsAt: new Date('2026-11-10T00:00:00Z'),
  exhaustedUntil: null,
  ...extra,
})

export interface World {
  db: TestCluster
  clock: FixedClock
  source: FakeSource
  host: FakeHost
  accounts: FakeAccounts
  deps: CapacityDeps & SyncDeps
  reset(): Promise<void>
  stop(): Promise<void>
  file(input: { repo: string; title?: string; kind?: IssueEvent<'filed'>['payload']['kind'] }): Promise<IssueId>
  send(issue: IssueId, name: string, kind: EventKind, payload: object, actor?: Actor): Promise<string>
  /** file, settle and return the Issue */
  queued(input: { repo: string; title?: string; kind?: IssueEvent<'filed'>['payload']['kind'] }): Promise<IssueId>
}

export async function startWorld(): Promise<World> {
  const db = await startTestCluster()
  const clock = fixedClock('2026-11-07T12:00:00Z')
  const source = new FakeSource()
  const host = new FakeHost()
  const accounts = new FakeAccounts()
  const uow = postgresUnitOfWork(db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    planning: postgresPlanningStore(tx),
    capacity: postgresCapacityStore(tx),
    reads: readIssues(tx),
  }))
  const world: World = {
    db,
    clock,
    source,
    host,
    accounts,
    deps: {
      uow,
      clock,
      ids: sequentialIds(),
      source,
      host,
      accounts,
      limits: { leadsPerAccount: 2, loadCeiling: 60, memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 } },
    },
    async reset() {
      await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
      await migrate(db.sql, await loadMigrations())
      source.repos.clear()
      source.reads = []
      host.loadValue = ok(1)
      host.memoryValue = ok({ swapoutMbPer300s: 0, swapUsedPct: 10 })
      accounts.rows = [account('me')]
      accounts.fail = false
      accounts.reads = 0
      clock.set(new Date('2026-11-07T12:00:00Z'))
      world.deps.ids = sequentialIds()
    },
    stop: () => db.stop(),
    async file(input) {
      const n = world.deps.ids.next('signal')
      const result = value(
        await fileIssue(world.deps, {
          key: key('filed', n),
          event: {
            kind: 'filed',
            payload: {
              repo: input.repo,
              title: input.title ?? 'a change',
              kind: input.kind ?? 'feature',
              origin: 'you',
            },
            actor: 'factory',
          },
        }),
      )
      return result.issue.id
    },
    async send(issue, name, kind, payload, actor = 'factory') {
      const recorded = value(
        await recordIssueEvent(world.deps, {
          issueId: issue,
          key: key('test', issue, name),
          event: { kind, payload, actor } as AnyIssueEvent,
        }),
      )
      return recorded.result === 'applied' ? recorded.issue.state : `${recorded.result}: ${recorded.event.detail}`
    },
    async queued(input) {
      const issue = await world.file(input)
      await world.send(issue, 'settled', 'settled', {})
      return issue
    },
  }
  return world
}
