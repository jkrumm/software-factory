import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
