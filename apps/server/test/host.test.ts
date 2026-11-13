import { afterAll, beforeAll, expect, test } from 'bun:test'
import { HostHistoryModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../src/adapters/postgres/loop-store.ts'
import { postgresUnitOfWork } from '../src/adapters/postgres/unit-of-work.ts'
import { hostWatch } from '../src/adapters/planning/host-watch.ts'
import { parsePs, residentBytes, topProcesses } from '../src/adapters/planning/ps.ts'
import { memoryUsedPct } from '../src/adapters/planning/vm-memory.ts'
import { readLeadCosts } from '../src/read/lead-costs.ts'
import { createApp } from '../src/api/app.ts'
import { hostPass } from '../src/app/loops/host.ts'

const PS = `    1     0   0.1    12288 /sbin/launchd
  412     1  96.4  2411520 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  733     1  41.2  1843200 /opt/tools/bin/bun
 1204   733  17.3  3145728 claude
garbage line
   55     1   0,5      100 -zsh
`

test('ps: rows parse, a command is its basename (spaces kept), a bad line is skipped', () => {
  const rows = parsePs(PS)
  expect(rows.map((r) => r.command)).toEqual(['launchd', 'Google Chrome', 'bun', 'claude', '-zsh'])
  expect(rows[1]).toEqual({ pid: 412, ppid: 1, command: 'Google Chrome', cpuPct: 96.4, rssKib: 2411520 })
  expect(rows[4]?.cpuPct).toBe(0.5)
})

test('ps: top lists are cut and ordered, rss becomes MiB', () => {
  const { topByCpu, topByMemory } = topProcesses(parsePs(PS), 2)
  expect(topByCpu.map((p) => p.command)).toEqual(['Google Chrome', 'bun'])
  expect(topByMemory.map((p) => [p.command, p.memoryMb])).toEqual([
    ['claude', 3072],
    ['Google Chrome', 2355],
  ])
  expect(residentBytes(parsePs('1 0 0 1 a\n2 0 0 3 b'))).toBe(4096)
})

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   109766.
Pages wired down:                             139712.
Pages purgeable:                                1624.
Pages stored in compressor:                   853868.
Pages occupied by compressor:                 467083.
`

test('memoryUsedPct: app + wired + compressed over RAM, null when anything is missing or malformed', () => {
  const sysctl = '943379\n1554\n16384\n'
  expect(memoryUsedPct(sysctl, VM_STAT, 34359738368)).toBe(73.8)
  expect(memoryUsedPct(sysctl, 'nothing useful', 34359738368)).toBeNull()
  expect(memoryUsedPct('x\ny\nz', VM_STAT, 34359738368)).toBeNull()
  expect(memoryUsedPct('', VM_STAT, 34359738368)).toBeNull()
  expect(memoryUsedPct(sysctl, VM_STAT, 0)).toBeNull()
})

const script = (body: string) => `#!/bin/sh\n${body}\n`
const fakeBin = async (name: string, body: string) => {
  const path = `${await Bun.$`mktemp -d`.text().then((t) => t.trim())}/${name}`
  await Bun.write(path, script(body))
  await Bun.$`chmod +x ${path}`.quiet()
  return path
}

test('hostWatch: one ps serves readers within the cache; a failed ps gives empty lists and a null memory', async () => {
  const counter = `${await Bun.$`mktemp -d`.text().then((t) => t.trim())}/n`
  const ps = await fakeBin('ps', `echo x >> ${counter}\nprintf '%s\\n' '  7  1  50.0  1048576 /bin/thing'`)
  const sysctl = await fakeBin(
    'sysctl',
    `case "$2" in hw.memsize) echo 4294967296;; *) printf '200000\\n0\\n4096\\n';; esac`,
  )
  const vmStat = await fakeBin(
    'vm_stat',
    `printf '%s\\n' 'Mach Virtual Memory Statistics: (page size of 4096 bytes)' 'Pages wired down:   40000.' 'Pages occupied by compressor:   22144.'`,
  )
  const host = {
    load: async () => ({ ok: true as const, value: 1.5 }),
    memory: async () => ({ ok: false as const, error: { kind: 'gone' as const, detail: 'x' } }),
    ramMib: async () => ({ ok: true as const, value: 4096 }),
    uptimeMs: async () => ({ ok: true as const, value: 3_600_000 }),
  }
  let t = 0
  const watch = hostWatch({ host, sysctlBin: sysctl, psBin: ps, vmStatBin: vmStat, now: () => t })
  const [a, b] = await Promise.all([watch.top(), watch.top()])
  expect(a).toEqual(b)
  expect(a.topByCpu).toEqual([{ pid: 7, command: 'thing', cpuPct: 50, memoryMb: 1024 }])
  expect(await watch.sample()).toEqual({ load: 1.5, memoryUsedPct: 25, swapUsedPct: null, swapoutMbPer300s: null })
  expect((await Bun.file(counter).text()).trim().split('\n')).toHaveLength(1)
  t = 11_000
  await watch.top()
  expect((await Bun.file(counter).text()).trim().split('\n')).toHaveLength(2)

  const broken = hostWatch({ host, sysctlBin: '/nonexistent/sysctl', psBin: '/nonexistent/ps' })
  expect(await broken.top()).toEqual({ topByCpu: [], topByMemory: [] })
  expect(await broken.sample()).toMatchObject({ memoryUsedPct: null })
})

let db: TestCluster
beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

test('a pass writes one row and prunes what is older than 25 hours', async () => {
  const uow = postgresUnitOfWork(db.sql, (tx) => ({ loops: postgresLoopStore(tx) }))
  const now = new Date()
  const old = new Date(now.getTime() - 26 * 3_600_000)
  await db.sql`INSERT INTO factory.host_samples (at, load) VALUES (${old}, 1)`
  const pass = await hostPass({
    uow,
    clock: { now: () => now },
    sampler: { sample: async () => ({ load: 2, memoryUsedPct: null, swapUsedPct: 10, swapoutMbPer300s: 0 }) },
    processes: { read: async () => null },
    facts: async () => ({ ok: false, error: { kind: 'gone', detail: 'x' } }),
  })
  expect(pass).toEqual({ ok: true, value: { pruned: 1, leadRows: null } })
  const rows =
    await db.sql`SELECT load, memory_used_pct, swap_used_pct, leads, queued, seats, load_ceiling FROM factory.host_samples`
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    load: 2,
    memory_used_pct: null,
    swap_used_pct: 10,
    leads: null,
    queued: null,
    seats: null,
    load_ceiling: null,
  })
  expect(await db.sql`SELECT 1 FROM factory.lead_samples`).toHaveLength(0)
})

test('a pass with a process table stores the facts and one row per lead, and prunes lead samples after 30 days', async () => {
  const uow = postgresUnitOfWork(db.sql, (tx) => ({ loops: postgresLoopStore(tx) }))
  const now = new Date()
  const base = '/work/app/.claude/worktrees/factory-7-1'
  await db.sql`
    INSERT INTO factory.lead_attempts (issue_id, attempt, branch, repo_path, worktree_path, first_try_at)
    VALUES ('issue_7', 1, 'factory/7-1', '/work/app', ${base}, ${now}),
      ('issue_8', 1, 'factory/8-1', '/work/app', '/work/app/.claude/worktrees/factory-8-1', ${now})`
  await db.sql`UPDATE factory.lead_attempts SET gone_at = ${new Date(now.getTime() - 3_600_000)} WHERE issue_id = 'issue_8'`
  await db.sql`
    INSERT INTO factory.lead_samples (at, worktree, repo, rss_mib, procs)
    VALUES (${new Date(now.getTime() - 31 * 86_400_000)}, '/old', 'app', 10, 1), (${new Date(now.getTime() - 86_400_000)}, '/recent', 'app', 10, 1)`
  const pass = await hostPass({
    uow,
    clock: { now: () => now },
    sampler: { sample: async () => ({ load: 1, memoryUsedPct: 5, swapUsedPct: 1, swapoutMbPer300s: 0 }) },
    processes: {
      read: async () => [
        { pid: 10, ppid: 1, rssKib: 2048, cwd: base },
        { pid: 11, ppid: 10, rssKib: 1024, cwd: '/elsewhere' },
        { pid: 20, ppid: 1, rssKib: 4096, cwd: '/work/app/.claude/worktrees/factory-8-1' },
      ],
    },
    facts: async () => ({ ok: true, value: { leads: 1, queued: 2, seats: 16, loadCeiling: 6.5 } }),
  })
  expect(pass).toEqual({ ok: true, value: { pruned: 0, leadRows: 1 } })
  const [sample] = await db.sql`SELECT leads, queued, seats, load_ceiling FROM factory.host_samples WHERE at = ${now}`
  expect(sample).toEqual({ leads: 1, queued: 2, seats: 16, load_ceiling: 6.5 })
  const rows =
    await db.sql`SELECT worktree, repo, issue, attempt, rss_mib, procs FROM factory.lead_samples ORDER BY worktree`
  expect(rows).toEqual([
    { worktree: '/recent', repo: 'app', issue: null, attempt: null, rss_mib: 10, procs: 1 },
    { worktree: base, repo: 'app', issue: 7, attempt: 1, rss_mib: 3, procs: 2 },
  ])
  await db.sql`DELETE FROM factory.lead_samples`
  await db.sql`DELETE FROM factory.lead_attempts`
  await db.sql`DELETE FROM factory.host_samples WHERE at = ${now}`
})

test('readLeadCosts: per repo, the attempts, the p80 of the newest ten attempt peaks and the newest peak', async () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 12, min))
  const rows: [number, string, string, number][] = [
    // repo a: five attempts, peaks 100..500; the newest (w5) peaks at 500 in its last sample
    [0, 'a', 'w1', 50],
    [1, 'a', 'w1', 100],
    [2, 'a', 'w2', 200],
    [3, 'a', 'w3', 300],
    [4, 'a', 'w4', 400],
    [5, 'a', 'w5', 450],
    [6, 'a', 'w5', 500],
    [7, 'a', 'w5', 120],
    // repo b: two attempts
    [8, 'b', 'x1', 70],
    [9, 'b', 'x2', 90],
  ]
  for (const [min, repo, worktree, mib] of rows) {
    await db.sql`INSERT INTO factory.lead_samples (at, worktree, repo, rss_mib, procs) VALUES (${at(min)}, ${worktree}, ${repo}, ${mib}, 2)`
  }
  expect(await readLeadCosts(db.sql)).toEqual([
    { repo: 'a', attempts: 5, peakMibP80: 400, lastPeakMib: 500 },
    { repo: 'b', attempts: 2, peakMibP80: 90, lastPeakMib: 90 },
  ])
  await db.sql`DELETE FROM factory.lead_samples`
})

test('GET /v1/host: the model parses; no history gives samples []; unbound is 503', async () => {
  const tokens = {
    owner: 'owner-token-0123456789',
    agent: 'agent-token-0123456789',
    machine: 'door-token-0123456789',
    read: 'read-token-0123456789',
  }
  const base = { tokens, health: { read: () => Promise.reject(new Error('unused')) }, log: () => {} }
  const get = (app: ReturnType<typeof createApp>) =>
    app.handle(new Request('http://localhost/v1/host', { headers: { authorization: `Bearer ${tokens.owner}` } }))
  const startedAt = new Date('2026-11-09T08:00:00Z')
  const host = { version: 'v1', startedAt, top: async () => ({ topByCpu: [], topByMemory: [] }) }
  const bound = createApp({ ...base, readModels: { sql: db.sql, host } })
  const model = HostHistoryModel.parse(await (await get(bound)).json())
  expect(model).toMatchObject({ version: 'v1', startedAt: startedAt.toISOString() })
  expect(model.samples).toHaveLength(1)

  await db.sql`DELETE FROM factory.host_samples`
  expect(HostHistoryModel.parse(await (await get(bound)).json()).samples).toEqual([])
  expect((await get(createApp({ ...base, readModels: { sql: db.sql } }))).status).toBe(503)
  expect((await get(createApp(base))).status).toBe(503)
})
