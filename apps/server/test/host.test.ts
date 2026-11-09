import { afterAll, beforeAll, expect, test } from 'bun:test'
import { HostHistoryModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../src/adapters/postgres/loop-store.ts'
import { postgresUnitOfWork } from '../src/adapters/postgres/unit-of-work.ts'
import { hostWatch } from '../src/adapters/planning/host-watch.ts'
import { parsePs, residentBytes, topProcesses } from '../src/adapters/planning/ps.ts'
import { createApp } from '../src/api/app.ts'
import { hostPass } from '../src/app/loops/host.ts'

const PS = `    1   0.1    12288 /sbin/launchd
  412  96.4  2411520 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  733  41.2  1843200 /opt/tools/bin/bun
 1204  17.3  3145728 claude
garbage line
   55   0,5      100 -zsh
`

test('ps: rows parse, a command is its basename (spaces kept), a bad line is skipped', () => {
  const rows = parsePs(PS)
  expect(rows.map((r) => r.command)).toEqual(['launchd', 'Google Chrome', 'bun', 'claude', '-zsh'])
  expect(rows[1]).toEqual({ pid: 412, command: 'Google Chrome', cpuPct: 96.4, rssKib: 2411520 })
  expect(rows[4]?.cpuPct).toBe(0.5)
})

test('ps: top lists are cut and ordered, rss becomes MiB', () => {
  const { topByCpu, topByMemory } = topProcesses(parsePs(PS), 2)
  expect(topByCpu.map((p) => p.command)).toEqual(['Google Chrome', 'bun'])
  expect(topByMemory.map((p) => [p.command, p.memoryMb])).toEqual([
    ['claude', 3072],
    ['Google Chrome', 2355],
  ])
  expect(residentBytes(parsePs('1 0 1 a\n2 0 3 b'))).toBe(4096)
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
  const ps = await fakeBin('ps', `echo x >> ${counter}\nprintf '%s\\n' '  7  50.0  1048576 /bin/thing'`)
  const sysctl = await fakeBin('sysctl', 'echo 4294967296')
  const host = {
    load: async () => ({ ok: true as const, value: 1.5 }),
    memory: async () => ({ ok: false as const, error: { kind: 'gone' as const, detail: 'x' } }),
  }
  let t = 0
  const watch = hostWatch({ host, sysctlBin: sysctl, psBin: ps, now: () => t })
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
  })
  expect(pass).toEqual({ ok: true, value: { pruned: 1 } })
  const rows = await db.sql`SELECT load, memory_used_pct, swap_used_pct FROM factory.host_samples`
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ load: 2, memory_used_pct: null, swap_used_pct: 10 })
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
