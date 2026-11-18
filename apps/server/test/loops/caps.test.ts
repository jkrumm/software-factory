import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { throughputPass, type ThroughputPass } from '../../src/app/loops/throughput.ts'
import type { UnitOfWork } from '../../src/app/unit-of-work.ts'
import { type CapFact, capText, capTitle, bindingCaps } from '../../src/domains/loops/caps.ts'
import type { LoopStore } from '../../src/domains/loops/ports.ts'
import type { ProjectShape } from '../../src/domains/loops/throughput.ts'
import { ok } from '../../src/kernel/result.ts'
import { readCapFacts } from '../../src/read/cap-facts.ts'
import { readIssueFates, readWindowFacts } from '../../src/read/throughput-loop.ts'

/**
 * A repo's lead cap that binds while seats idle: the throughput loop reads the host's minute samples and the queue's intervals,
 * and files one signal on the repo with the cap, its comment and the measured figures; a cap that is lifted, or that held
 * Issues back for less than an hour, or while no seat was free, files nothing. Real Postgres, seeded samples.
 */
let db: TestCluster
const NOW = new Date('2026-11-18T12:00:00Z')
const MINUTE = 60_000
const clock = { now: () => NOW }
const uow: UnitOfWork<{ loops: LoopStore }> = {
  run: (work) => work({ loops: postgresLoopStore(db.sql) }),
  inTransaction: () => false,
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

let n = 0
/** The host's minute samples ending a minute ago: `minutes` of them, with `seats` the accounts may hold and `leads` running. */
async function samples(minutes: number, seats: number, leads: number) {
  for (let i = 1; i <= minutes; i++) {
    await db.sql`INSERT INTO factory.host_samples (at, seats, leads) VALUES (${new Date(NOW.getTime() - i * MINUTE)}, ${seats}, ${leads})
      ON CONFLICT (at) DO UPDATE SET seats = EXCLUDED.seats, leads = EXCLUDED.leads`
  }
}
async function queuedFor(project: string, kind: string, minutesAgo: number) {
  n++
  const id = `issue_${5000 + n}`
  await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, ${project}, 'queued', 1)`
  await db.sql`INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at)
    VALUES (${id}, ${project}, ${kind}, 'no claim free in the repo', ${new Date(NOW.getTime() - minutesAgo * MINUTE)})`
}
async function cleanSlate() {
  await db.sql`DELETE FROM factory.queue_intervals`
  await db.sql`DELETE FROM factory.host_samples`
  await db.sql`DELETE FROM factory.worktree_sizes`
}

const COMMENT = '# each worktree has its own target/ (tens of GiB each)'
const shapes = (leads: number): ReadonlyMap<string, ProjectShape> =>
  new Map([['shutterflow', { leads, lanes: new Map<string, number | null>() }]])

async function run(d: ReturnType<typeof deps>): Promise<ThroughputPass> {
  const result = await throughputPass(d)
  if (!result.ok) throw new Error(`the pass failed: ${result.error.kind}`)
  return result.value
}

function deps(shape: ReadonlyMap<string, ProjectShape>, filed: { title: string; text: string; repo: string }[]) {
  const open = new Set<string>()
  return {
    uow,
    clock,
    tenants: { project: 'dotfiles', budgetMib: 6144 },
    projects: async () => [
      { project: 'shutterflow', repo: 'shutterflow', peakMib: null as number | null, shape: shape.get('shutterflow') },
    ],
    facts: (
      window: { from: Date; to: Date },
      options: { baseline: boolean; peakBudgetMib: ReadonlyMap<string, number> },
    ) => readWindowFacts(db.sql, { ...window, ...options }),
    fates: (ids: readonly string[]) => readIssueFates(db.sql, ids),
    caps: async (at: Date, s: ReadonlyMap<string, ProjectShape>) =>
      (await readCapFacts(db.sql, { to: at, shapes: s, disk: { freeMib: 130 * 1024, totalMib: 1024 * 1024 } })).map(
        (f) => ({
          ...f,
          comment: COMMENT,
        }),
      ),
    // intake's rule: the same repo and title while one is open is a repeat
    file: (async (body: { title: string; text: string; repo?: string }) => {
      const fingerprint = `${body.repo}\n${body.title}`
      if (open.has(fingerprint))
        return ok({ outcome: 'dropped', detail: 'repeat', issue: 'issue_1', signal: 'sig_1', reason: null })
      open.add(fingerprint)
      filed.push({ title: body.title, text: body.text, repo: body.repo ?? '' })
      return ok({ outcome: 'filed', detail: 'filed', issue: 'issue_1', signal: 'sig_1', reason: null })
    }) as never,
  }
}

describe('a binding cap is a finding', () => {
  test('a cap that held an Issue queued for 90 minutes while seats idled files one signal, and none again while it is open', async () => {
    await cleanSlate()
    await samples(90, 10, 2)
    await queuedFor('shutterflow', 'claim', 120)
    for (const [i, mib] of [1900, 2100, 2150].entries()) {
      await db.sql`INSERT INTO factory.worktree_sizes (worktree, repo, issue, attempt, mib, measured_at)
        VALUES (${`/w/${i}`}, 'shutterflow', ${i}, 1, ${mib}, ${NOW})`
    }
    const all: { title: string; text: string; repo: string }[] = []
    const d = deps(shapes(2), all)
    const caps = () => all.filter((f) => f.title.startsWith('The lead cap'))
    const pass = await run(d)
    expect(pass.caps).toEqual([{ project: 'shutterflow', cap: 'leads: 2', issue: 'issue_1' }])
    expect(caps()).toHaveLength(1)
    const signal = caps()[0]
    expect(signal?.title).toBe('The lead cap `leads: 2` of shutterflow binds while seats idle')
    expect(signal?.repo).toBe('shutterflow')
    const text = signal?.text ?? ''
    expect(text).toContain('queued for a claim for 90 of the last 6 hours while a median 8 account seats sat idle')
    expect(text).toContain(COMMENT)
    expect(text).toContain(
      'a worktree with its build output measured 2.1 GiB (p80 of 3 attempts), the largest 2.1 GiB; the host has 130 GiB free',
    )
    expect(text).toContain('Default fix: remove the cap')

    const again = await run(d)
    expect(again.caps).toHaveLength(1)
    expect(caps()).toHaveLength(1)
  })

  test('a cap that held Issues back for under an hour files nothing', async () => {
    await cleanSlate()
    await samples(40, 10, 2)
    await queuedFor('shutterflow', 'claim', 120)
    const filed: { title: string; text: string; repo: string }[] = []
    const pass = await run(deps(shapes(2), filed))
    expect(pass.caps).toEqual([])
    expect(filed.filter((f) => f.title.startsWith('The lead cap'))).toEqual([])
  })

  test("a cap with no seat idle is the accounts' limit, not the cap's: files nothing", async () => {
    await cleanSlate()
    await samples(90, 10, 10)
    await queuedFor('shutterflow', 'claim', 120)
    const filed: { title: string; text: string; repo: string }[] = []
    const pass = await run(deps(shapes(2), filed))
    expect(pass.caps).toEqual([])
  })

  test('a cap the owner already lifted is not challenged on the old waits', async () => {
    await cleanSlate()
    await samples(90, 10, 2)
    await queuedFor('shutterflow', 'claim', 120)
    const filed: { title: string; text: string; repo: string }[] = []
    const pass = await run(deps(shapes(64), filed))
    expect(pass.caps).toEqual([])
    expect(filed.filter((f) => f.title.startsWith('The lead cap'))).toEqual([])
  })
})

describe('what the signal quotes for the resource the comment names', () => {
  const fact = (comment: string | null): CapFact => ({
    project: 'argo',
    lane: null,
    cap: 1,
    comment,
    bindingMinutes: 200,
    issues: 4,
    idleSeats: 12,
    hours: 6,
    figures: {
      worktrees: { attempts: 5, p80Mib: 1500, largestMib: 2100 },
      disk: { freeMib: 130 * 1024, totalMib: 500 * 1024 },
      lead: { attempts: 8, p80Mib: 900 },
      mergeWindows: { days: 7, windows: 40, holdMedianMinutes: 6, waitMedianMinutes: 2.5 },
    },
  })

  test('a merge window comment is answered with the merge windows used', () => {
    const text = capText(fact('# the merge window serialises merges'))
    expect(text).toContain('Merge windows: 40 in 7 days, held a median 6 min, waited for a median 2.5 min')
    expect(text).toContain('factory merge-lock')
    expect(text).not.toContain('Disk:')
  })

  test('a comment that records no reason is answered with every figure', () => {
    const text = capText(fact('# no reason was recorded'))
    expect(text).toContain('Disk:')
    expect(text).toContain('Memory:')
    expect(text).toContain('Merge windows:')
  })

  test('a lane cap is named as the lane, and a lifted or short binding is not a finding', () => {
    const lane = { ...fact(null), lane: 'apple', cap: 1 }
    expect(capTitle(lane)).toBe('The lead cap `lanes.apple.leads: 1` of argo binds while seats idle')
    expect(bindingCaps([lane, { ...lane, bindingMinutes: 59 }, { ...lane, cap: 64 }])).toEqual([lane])
  })
})
