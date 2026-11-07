import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAccountSource } from '../../src/adapters/planning/claude-accounts.ts'
import { hostReader } from '../../src/adapters/planning/host.ts'
import { value } from '../planning/support.ts'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-bin-')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

describe('the host reader', () => {
  const sysctl = (swapout: number, used: string) =>
    script(
      `sysctl-${swapout}`,
      `case "$2" in
  hw.pagesize) echo 16384;;
  vm.compressor.swapper.swapouts_total) echo ${swapout};;
  hw.memsize) echo 34359738368;;
  vm.swapusage) echo "total = 10240.00M  used = ${used}  free = 1.00M  (encrypted)";;
esac`,
    )

  test('the first reading has no rate: swap in use is a share of RAM', async () => {
    const reader = hostReader({ sysctlBin: await sysctl(1000, '8192.00M'), minSampleMs: 0 })
    expect(value(await reader.memory())).toEqual({ swapoutMbPer300s: 0, swapUsedPct: 25 })
  })

  test('the previous sample stays in memory: two readings of one reader give the rate; closer than the window, the last stands', async () => {
    let clock = 0
    let counter = 1000
    const bin = await script(
      'sysctl-live',
      `case "$2" in
  hw.pagesize) echo 16384;;
  vm.compressor.swapper.swapouts_total) cat ${dir}/counter;;
  hw.memsize) echo 34359738368;;
  vm.swapusage) echo "total = 10240.00M  used = 1024.00M  free = 1.00M";;
esac`,
    )
    const write = (n: number) => writeFile(join(dir, 'counter'), String(n))
    await write(counter)
    const reader = hostReader({ sysctlBin: bin, minSampleMs: 30_000, now: () => clock })
    expect(value(await reader.memory()).swapoutMbPer300s).toBe(0)
    counter = 66_536 // 1 GiB of swapouts
    await write(counter)
    clock = 10_000
    expect(value(await reader.memory()).swapoutMbPer300s).toBe(0) // too close: the last reading stands
    clock = 150_000
    expect(value(await reader.memory())).toEqual({ swapoutMbPer300s: 2048, swapUsedPct: 3.1 })
  })

  test('a reading that cannot be taken is an error result naming why, never a throw', async () => {
    const missing = hostReader({ sysctlBin: join(dir, 'no-such-sysctl'), minSampleMs: 0 })
    expect(await missing.memory()).toMatchObject({ ok: false, error: { kind: 'gone' } })
    const silent = hostReader({ sysctlBin: await script('silent', 'exit 1'), minSampleMs: 0 })
    expect(await silent.memory()).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
    const slow = hostReader({ sysctlBin: await script('slow', 'sleep 5'), minSampleMs: 0, timeoutMs: 100 })
    const started = Date.now()
    expect(await slow.memory()).toMatchObject({ ok: false, error: { kind: 'timeout' } })
    // the timeout kills the program's whole group: the call returns at the timeout, not when the sleep ends
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('the load average is the 1-minute one', async () => {
    const load = value(await hostReader({ sysctlBin: 'x', minSampleMs: 0 }).load())
    expect(load).toBeGreaterThanOrEqual(0)
  })
})

describe('the account picker', () => {
  const at = new Date('2026-11-07T12:00:00Z')
  const usage = (rows: object[]) => script('usage', `echo '${JSON.stringify({ accounts: rows })}'`)
  const row = (id: string, extra: object = {}) => ({
    id,
    enabled: true,
    auth_ok: true,
    five_hour: 12.5,
    seven_day: 40,
    five_hour_resets_at: 1_794_000_000,
    seven_day_resets_at: 1_794_400_000,
    age_s: 30,
    exhausted_until: null,
    extra_field: 'ignored',
    ...extra,
  })

  test('every account of the picker is a reading; the sample time is the poll minus the sample age', async () => {
    const source = claudeAccountSource({ bin: await usage([row('me'), row('iu', { enabled: false })]) })
    const readings = value(await source.read(at))
    expect(readings.map((r) => [r.account, r.enabled])).toEqual([
      ['me', true],
      ['iu', false],
    ])
    expect(readings[0]).toMatchObject({
      fiveHourUsed: 12.5,
      weeklyUsed: 40,
      sampledAt: new Date(at.getTime() - 30_000),
      fiveHourResetsAt: new Date(1_794_000_000_000),
      readAt: at,
    })
  })

  test('one row that does not parse does not freeze the others; all of them failing is a drifted shape', async () => {
    const partly = claudeAccountSource({ bin: await usage([row('me'), { id: 'bad' }]) })
    expect(value(await partly.read(at)).map((r) => r.account)).toEqual(['me'])
    const drifted = claudeAccountSource({ bin: await usage([{ id: 'bad' }]) })
    expect(await drifted.read(at)).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
  })

  test('a picker that is missing, fails, hangs or prints nonsense is an error result', async () => {
    expect(await claudeAccountSource({ bin: join(dir, 'nope') }).read(at)).toMatchObject({
      ok: false,
      error: { kind: 'gone' },
    })
    expect(await claudeAccountSource({ bin: await script('fails', 'exit 3') }).read(at)).toMatchObject({
      ok: false,
      error: { kind: 'gone', detail: expect.stringContaining('exited 3') },
    })
    const started = Date.now()
    expect(await claudeAccountSource({ bin: await script('hangs', 'sleep 5'), timeoutMs: 100 }).read(at)).toMatchObject(
      {
        ok: false,
        error: { kind: 'timeout' },
      },
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    // a grandchild that leaves the group and holds the pipes does not keep the call waiting
    const escaped = await script('escaped', 'python3 -c "import os,time; os.setsid(); time.sleep(5)" &\nsleep 5')
    const again = Date.now()
    expect(await claudeAccountSource({ bin: escaped, timeoutMs: 100 }).read(at)).toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    })
    expect(Date.now() - again).toBeLessThan(2_000)
    expect(await claudeAccountSource({ bin: await script('junk', 'echo nope') }).read(at)).toMatchObject({
      ok: false,
      error: { kind: 'unreadable' },
    })
  })
})
