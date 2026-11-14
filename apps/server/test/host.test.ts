import { afterAll, beforeAll, expect, test } from 'bun:test'
import { HostHistoryModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../src/adapters/postgres/loop-store.ts'
import { postgresUnitOfWork } from '../src/adapters/postgres/unit-of-work.ts'
import { hostWatch } from '../src/adapters/planning/host-watch.ts'
import { parsePs, residentBytes, topProcesses } from '../src/adapters/planning/ps.ts'
import { parseTopFootprints } from '../src/adapters/planning/top.ts'
import { memoryUsedPct } from '../src/adapters/planning/vm-memory.ts'
import { readLeadCosts } from '../src/read/lead-costs.ts'
import { createApp } from '../src/api/app.ts'
import { hostPass } from '../src/app/loops/host.ts'
import { textRunner } from '../src/adapters/planning/process.ts'
import { hostSnapshot } from '../src/adapters/planning/snapshot.ts'
import { emptySnapshotMemory, type SnapshotProc } from '../src/domains/capacity/classes.ts'

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

// `top -l 1 -n 5000 -stats pid,mem` of the mini (2026-11-13, trimmed): a header, then one row per process in K, M or G
const TOP_OUTPUT = `Processes: 843 total, 5 running, 2 stuck, 836 sleeping, 5239 threads
2026/11/13 23:23:03
Load Avg: 6.87, 6.51, 5.50
PhysMem: 30G used (2352M wired, 14G compressor), 923M unused.

PID    MEM
99855  16M
97653  2544K
463    1536M+
645    1.5G
601    81M-
broken line
7      12X
`

test('top: footprints parse to KiB from K, M and G (a decimal too), a header or odd line is skipped', () => {
  expect([...parseTopFootprints(TOP_OUTPUT)]).toEqual([
    [99855, 16 * 1024],
    [97653, 2544],
    [463, 1536 * 1024],
    [645, 1.5 * 1024 * 1024],
    [601, 81 * 1024],
  ])
  expect(parseTopFootprints('').size).toBe(0)
  expect(parseTopFootprints('5 10M\n5 20M\n').get(5)).toBe(10 * 1024)
})

test('hostWatch: one top serves readers within the cache; a failed, empty or absent top is null', async () => {
  const counter = `${await Bun.$`mktemp -d`.text().then((t) => t.trim())}/n`
  const top = await fakeBin('top', `echo x >> ${counter}\nprintf '%s\\n' 'PID    MEM' '7  300M' '8  4096K'`)
  const host = {
    load: async () => ({ ok: true as const, value: 1 }),
    memory: async () => ({ ok: false as const, error: { kind: 'gone' as const, detail: 'x' } }),
    ramMib: async () => ({ ok: true as const, value: 4096 }),
    uptimeMs: async () => ({ ok: true as const, value: 3_600_000 }),
  }
  let t = 0
  const watch = hostWatch({
    host,
    sysctlBin: '/nonexistent/sysctl',
    psBin: '/nonexistent/ps',
    topBin: top,
    now: () => t,
  })
  const [a, b] = await Promise.all([watch.footprints(), watch.footprints()])
  expect(a).toEqual(b)
  expect([...(a ?? [])]).toEqual([
    [7, 300 * 1024],
    [8, 4096],
  ])
  expect((await Bun.file(counter).text()).trim().split('\n')).toHaveLength(1)
  t = 11_000
  await watch.footprints()
  expect((await Bun.file(counter).text()).trim().split('\n')).toHaveLength(2)

  const failing = await fakeBin('top-fails', 'exit 1')
  const empty = await fakeBin('top-empty', `printf '%s\\n' 'PID    MEM'`)
  for (const topBin of [failing, empty, '/nonexistent/top', undefined]) {
    expect(await hostWatch({ host, sysctlBin: '/x', psBin: '/x', topBin }).footprints()).toBeNull()
  }
})

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

test('hostSnapshot: a full reading joins every helper; a failed ps, launchctl or lsof keeps the signals and no procs', async () => {
  const top = await fakeBin(
    'top',
    `printf '%s\\n' 'Processes: 2 total' 'CPU usage: 1.0% user, 2.0% sys, 97.0% idle' 'PID PPID MEM TIME' '7  1  300M 00:01.00' '8  7  4096K 00:00.50'`,
  )
  const ps = await fakeBin('ps', `printf '%s\\n' '7 1 me /opt/bin/worker' '8 7 me /opt/bin/child'`)
  const launchctl = await fakeBin('launchctl', `printf 'PID\\tStatus\\tLabel\\n7\\t0\\tcom.example.worker\\n'`)
  const sysctl = await fakeBin('sysctl', `printf '2\\n1073741824\\n'`)
  const failing = await fakeBin('fails', 'exit 1')
  const reader = (overrides: { psBin?: string; launchctlBin?: string; cwds?: Map<number, string> | null }) => {
    const runner = textRunner(5_000)
    const watch = hostWatch({ host: {} as never, sysctlBin: sysctl, psBin: ps, topBin: top, runner })
    return hostSnapshot({
      top: () => watch.topSnapshot(),
      cwds: async () => (overrides.cwds === undefined ? new Map([[7, '/srv']]) : overrides.cwds),
      runner,
      psBin: overrides.psBin ?? ps,
      launchctlBin: overrides.launchctlBin ?? launchctl,
      lsofBin: failing,
      sysctlBin: sysctl,
      vmVolume: '/',
    })
  }
  const full = await reader({}).read()
  expect(full).toMatchObject({ processes: 2, cpuIdlePct: 97, pressureLevel: 2, compressorMib: 1024 })
  expect(full?.vmFreeGib).toBeGreaterThan(0)
  expect(full?.procs?.map((p) => [p.pid, p.name, p.label, p.cwd])).toEqual([
    [7, 'worker', 'com.example.worker', '/srv'],
    [8, 'child', null, null],
  ])
  for (const degraded of [{ psBin: failing }, { launchctlBin: failing }, { cwds: null }]) {
    const reading = await reader(degraded).read()
    expect(reading).toMatchObject({ procs: null, processes: 2, pressureLevel: 2 })
  }
})

let db: TestCluster
beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

const noSnapshot = () => ({
  snapshot: { read: async () => null },
  memory: { current: emptySnapshotMemory() },
  self: { pid: 1, dirs: [] },
})

test('a pass writes one row and prunes what is older than 14 days', async () => {
  const uow = postgresUnitOfWork(db.sql, (tx) => ({ loops: postgresLoopStore(tx) }))
  const now = new Date()
  const old = new Date(now.getTime() - 15 * 86_400_000)
  await db.sql`INSERT INTO factory.host_samples (at, load) VALUES (${old}, 1), (${new Date(now.getTime() - 86_400_000)}, 1)`
  const pass = await hostPass({
    uow,
    clock: { now: () => now },
    sampler: { sample: async () => ({ load: 2, memoryUsedPct: null, swapUsedPct: 10, swapoutMbPer300s: 0 }) },
    processes: { read: async () => null },
    ...noSnapshot(),
    facts: async () => ({ ok: false, error: { kind: 'gone', detail: 'x' } }),
  })
  expect(pass).toEqual({ ok: true, value: { pruned: 1, leadRows: null, classRows: null } })
  await db.sql`DELETE FROM factory.host_samples WHERE at < ${now}`
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
        { pid: 10, ppid: 1, rssKib: 2048, footprintKib: 1024, cwd: base },
        { pid: 11, ppid: 10, rssKib: 1024, footprintKib: 512, cwd: '/elsewhere' },
        { pid: 20, ppid: 1, rssKib: 4096, footprintKib: null, cwd: '/work/app/.claude/worktrees/factory-8-1' },
      ],
    },
    ...noSnapshot(),
    facts: async () => ({ ok: true, value: { leads: 1, queued: 2, seats: 16, loadCeiling: 6.5 } }),
  })
  expect(pass).toEqual({ ok: true, value: { pruned: 0, leadRows: 1, classRows: null } })
  const [sample] = await db.sql`SELECT leads, queued, seats, load_ceiling FROM factory.host_samples WHERE at = ${now}`
  expect(sample).toEqual({ leads: 1, queued: 2, seats: 16, load_ceiling: 6.5 })
  const rows =
    await db.sql`SELECT worktree, repo, issue, attempt, rss_mib, footprint_mib, procs FROM factory.lead_samples ORDER BY worktree`
  expect(rows).toEqual([
    { worktree: '/recent', repo: 'app', issue: null, attempt: null, rss_mib: 10, footprint_mib: null, procs: 1 },
    { worktree: base, repo: 'app', issue: 7, attempt: 1, rss_mib: 3, footprint_mib: 2, procs: 2 },
  ])
  await db.sql`DELETE FROM factory.lead_samples`
  await db.sql`DELETE FROM factory.lead_attempts`
  await db.sql`DELETE FROM factory.host_samples WHERE at = ${now}`
})

test('a pass with a snapshot stores the signals, the class rows and the notable processes, rolls hours up and prunes', async () => {
  const uow = postgresUnitOfWork(db.sql, (tx) => ({ loops: postgresLoopStore(tx) }))
  const t0 = new Date(Date.UTC(2026, 10, 14, 10, 59))
  const worktree = '/work/app/.claude/worktrees/factory-9-1'
  await db.sql`
    INSERT INTO factory.lead_attempts (issue_id, attempt, branch, repo_path, worktree_path, first_try_at)
    VALUES ('issue_9', 1, 'factory/9-1', '/work/app', ${worktree}, ${t0})`
  await db.sql`INSERT INTO factory.host_class_samples (at, class, footprint_mib, procs) VALUES (${new Date(t0.getTime() - 15 * 86_400_000)}, 'other', 1, 1)`
  await db.sql`INSERT INTO factory.host_class_hours (hour, class, mib_minutes, peak_mib, cpu_seconds, minutes) VALUES (${new Date(t0.getTime() - 401 * 86_400_000)}, 'other', 1, 1, 0, 1)`
  const proc = (
    pid: number,
    ppid: number,
    mib: number,
    cpuS: number,
    extra: Partial<SnapshotProc> = {},
  ): SnapshotProc => ({
    pid,
    ppid,
    footprintKib: mib * 1024,
    cpuMs: cpuS * 1000,
    name: `p${pid}`,
    user: 'me',
    exe: `/opt/bin/p${pid}`,
    label: null,
    session: null,
    slot: null,
    slotActive: false,
    vm: null,
    cwd: null,
    ...extra,
  })
  // a lead (claude in its worktree) with a slot run under it, a tenant job, the server's job, and a root daemon
  const snapshotAt = (claudeMib: number, cpuS: number) => [
    proc(1, 0, 10, 1, { user: 'root', exe: '/sbin/launchd' }),
    proc(100, 1, claudeMib, cpuS, { cwd: worktree }),
    proc(101, 100, 50, cpuS, { slot: 'factory-9-1 make check-fast' }),
    proc(102, 101, 1500, cpuS, { slotActive: true }),
    proc(200, 1, 300, cpuS, { label: 'com.example.worker' }),
    proc(300, 1, 40, cpuS, { label: 'com.example.factory' }),
    proc(301, 300, 60, cpuS),
  ]
  let next = snapshotAt(200, 10)
  const deps = {
    uow,
    sampler: { sample: async () => ({ load: 3, memoryUsedPct: 50, swapUsedPct: 1, swapoutMbPer300s: 0 }) },
    processes: { read: async () => null },
    snapshot: {
      read: async () => ({
        procs: next,
        processes: 7,
        cpuIdlePct: 40.5,
        pressureLevel: 2,
        compressorMib: 900,
        vmFreeGib: 120.5,
        collectorCpuMs: 420,
      }),
    },
    memory: { current: emptySnapshotMemory() },
    self: { pid: 301, dirs: [] },
    facts: async () => ({ ok: false as const, error: { kind: 'gone' as const, detail: 'x' } }),
  }
  const first = await hostPass({ ...deps, clock: { now: () => t0 } })
  expect(first).toEqual({ ok: true, value: { pruned: 2, leadRows: null, classRows: 5 } })
  const [signals] = await db.sql`
    SELECT pressure_level, compressor_mib, processes, cpu_idle_pct, vm_free_gib, collector_cpu_ms
    FROM factory.host_samples WHERE at = ${t0}`
  expect(signals).toEqual({
    pressure_level: 2,
    compressor_mib: 900,
    processes: 7,
    cpu_idle_pct: 40.5,
    vm_free_gib: 120.5,
    collector_cpu_ms: 420,
  })
  const classesAt = (at: Date) => db.sql`
    SELECT class, repo, tenant, issue, step, footprint_mib, cpu_ms::int AS cpu_ms, procs
    FROM factory.host_class_samples WHERE at = ${at} ORDER BY footprint_mib DESC`
  // the first snapshot has no CPU figures: nothing to take a difference from
  expect(await classesAt(t0)).toEqual([
    {
      class: 'step',
      repo: 'app',
      tenant: null,
      issue: 9,
      step: 'make check-fast',
      footprint_mib: 1550,
      cpu_ms: null,
      procs: 2,
    },
    {
      class: 'tenant',
      repo: null,
      tenant: 'com.example.worker',
      issue: null,
      step: null,
      footprint_mib: 300,
      cpu_ms: null,
      procs: 1,
    },
    { class: 'lead', repo: 'app', tenant: null, issue: 9, step: null, footprint_mib: 200, cpu_ms: null, procs: 1 },
    { class: 'factory', repo: null, tenant: null, issue: null, step: null, footprint_mib: 100, cpu_ms: null, procs: 2 },
    { class: 'system', repo: null, tenant: null, issue: null, step: null, footprint_mib: 10, cpu_ms: null, procs: 1 },
  ])

  // a minute later the lead grew by 250 MiB and every process used 6 s more
  const t1 = new Date(t0.getTime() + 60_000)
  next = snapshotAt(450, 16)
  expect(await hostPass({ ...deps, clock: { now: () => t1 } })).toMatchObject({ ok: true, value: { classRows: 5 } })
  const lead = (await classesAt(t1)).find((row: { class: string }) => row.class === 'lead')
  expect(lead).toMatchObject({ footprint_mib: 450, cpu_ms: 6000 })
  const processes = await db.sql`
    SELECT pid, name, class, repo, issue, footprint_mib, why, grown_mib FROM factory.host_process_samples
    WHERE at = ${t1} ORDER BY footprint_mib DESC`
  expect(
    processes.map((row: { pid: number; why: string; grown_mib: number | null }) => [row.pid, row.why, row.grown_mib]),
  ).toEqual([
    [102, 'large', null],
    [100, 'growth', 250],
    [200, 'top', null],
    [301, 'top', null],
    [101, 'top', null],
    [300, 'top', null],
    [1, 'top', null],
  ])
  // t1 opened hour 11: hour 10 (one minute) is rolled up, per class, repo and tenant
  const hours = await db.sql`
    SELECT class, repo, tenant, mib_minutes::int AS mib_minutes, peak_mib, minutes FROM factory.host_class_hours
    WHERE hour = ${new Date(Date.UTC(2026, 10, 14, 10))} ORDER BY class`
  expect(hours).toEqual([
    { class: 'factory', repo: '', tenant: '', mib_minutes: 100, peak_mib: 100, minutes: 1 },
    { class: 'lead', repo: 'app', tenant: '', mib_minutes: 200, peak_mib: 200, minutes: 1 },
    { class: 'step', repo: 'app', tenant: '', mib_minutes: 1550, peak_mib: 1550, minutes: 1 },
    { class: 'system', repo: '', tenant: '', mib_minutes: 10, peak_mib: 10, minutes: 1 },
    { class: 'tenant', repo: '', tenant: 'com.example.worker', mib_minutes: 300, peak_mib: 300, minutes: 1 },
  ])
  await db.sql`DELETE FROM factory.host_class_samples`
  await db.sql`DELETE FROM factory.host_process_samples`
  await db.sql`DELETE FROM factory.host_class_hours`
  await db.sql`DELETE FROM factory.host_samples WHERE at IN (${t0}, ${t1})`
  await db.sql`DELETE FROM factory.lead_attempts`
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
  const none = {
    footprintAttempts: 0,
    footprintMibP80: null,
    lastFootprintMib: null,
    footprintToRss: null,
    restMibP50: null,
    restMinutes: 0,
  }
  expect(await readLeadCosts(db.sql)).toEqual([
    { repo: 'a', attempts: 5, peakMibP80: 400, lastPeakMib: 500, ...none },
    { repo: 'b', attempts: 2, peakMibP80: 90, lastPeakMib: 90, ...none },
  ])
  await db.sql`DELETE FROM factory.lead_samples`
})

test('readLeadCosts: the footprint figures come from the attempts that have one, and the ratio is their median', async () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 12, min))
  // repo c: w1 and w2 predate the footprint; w3..w5 have one (peak 60 of 100, 100 of 200, 150 of 300), w6 lost it to a failed top
  const rows: [number, string, number, number | null][] = [
    [0, 'w1', 100, null],
    [1, 'w2', 100, null],
    [2, 'w3', 100, 40],
    [3, 'w3', 90, 60],
    [4, 'w4', 200, 100],
    [5, 'w5', 300, 150],
    [6, 'w6', 400, null],
  ]
  for (const [min, worktree, rss, footprint] of rows) {
    await db.sql`INSERT INTO factory.lead_samples (at, worktree, repo, rss_mib, footprint_mib, procs) VALUES (${at(min)}, ${worktree}, 'c', ${rss}, ${footprint}, 2)`
  }
  expect(await readLeadCosts(db.sql)).toEqual([
    {
      repo: 'c',
      attempts: 6,
      peakMibP80: 300,
      lastPeakMib: 400,
      footprintAttempts: 3,
      footprintMibP80: 150,
      lastFootprintMib: 150,
      footprintToRss: 0.5,
      restMibP50: null,
      restMinutes: 0,
    },
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
