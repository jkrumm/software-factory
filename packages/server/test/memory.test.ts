import { describe, expect, test } from 'bun:test'
import { heldByMemory, MIN_SAMPLE_MS, SwapSampler, swapUsedBytes } from '../src/memory.ts'

const ceilings = { swapoutMbPer300s: 2048, swapUsedPct: 75 }

describe('the memory rule', () => {
  test('a high swapout rate or a high swap share holds, a normal reading does not', () => {
    expect(heldByMemory({ swapoutMbPer300s: 19_000, swapUsedPct: 5 }, ceilings)).toBe(true)
    expect(heldByMemory({ swapoutMbPer300s: 0, swapUsedPct: 206 }, ceilings)).toBe(true)
    expect(heldByMemory({ swapoutMbPer300s: 2048, swapUsedPct: 75 }, ceilings)).toBe(false)
    expect(heldByMemory({ swapoutMbPer300s: 100, swapUsedPct: 28 }, ceilings)).toBe(false)
  })
})

describe('the sampler', () => {
  const GIB = 1024 ** 3
  const setup = () => {
    const sysctl = { pages: 1000, used: '2048.00M' }
    let at = 1_000_000
    const sampler = new SwapSampler(
      (name) =>
        ({
          'hw.pagesize': '16384',
          'hw.memsize': String(32 * GIB),
          'vm.compressor.swapper.swapouts_total': String(sysctl.pages),
          'vm.swapusage': `total = 65536.00M  used = ${sysctl.used}  free = 100.00M  (encrypted)`,
        })[name] ?? '',
      () => at,
    )
    return { sysctl, sampler, advance: (ms: number) => (at += ms) }
  }

  test('the first reading has no rate; the next scales the delta to 300 s', () => {
    const { sysctl, sampler, advance } = setup()
    expect(sampler.sample()).toEqual({ swapoutMbPer300s: 0, swapUsedPct: 6.3 })
    sysctl.pages += (2 * GIB) / 16384 // 2 GiB in 60 s
    advance(60_000)
    expect(sampler.sample().swapoutMbPer300s).toBe(10_240)
  })

  test('readings inside the minimum window return the last one; a counter that fell starts over', () => {
    const { sysctl, sampler, advance } = setup()
    sampler.sample()
    sysctl.pages += 1_000_000
    advance(MIN_SAMPLE_MS - 1)
    expect(sampler.sample().swapoutMbPer300s).toBe(0)
    sysctl.pages = 5
    advance(MIN_SAMPLE_MS)
    expect(sampler.sample().swapoutMbPer300s).toBe(0)
  })

  test('an unreadable sysctl throws', () => {
    const sampler = new SwapSampler(() => {
      throw new Error('sysctl hw.pagesize gave no answer')
    })
    expect(() => sampler.sample()).toThrow('no answer')
    expect(() => swapUsedBytes('garbage')).toThrow('not understood')
  })
})
