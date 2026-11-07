import { loadavg } from 'node:os'
import { memoryReadingOf, type MemoryReading, type SwapSample, swapUsedBytes } from '../../domains/capacity/host.ts'
import type { HostReader } from '../../domains/capacity/ports.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { CannotStart, runProcess } from './process.ts'

export interface HostOptions {
  /** `sysctl`, the macOS tool whose counters the readings are */
  sysctlBin: string
  /** readings closer than this return the last one: many admissions in one pass cost one sample */
  minSampleMs: number
  timeoutMs?: number
  now?: () => number
}

const count = (name: string, value: string): Result<number, PortError> => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? ok(n) : err(portError('unreadable', `${name} is not a number: ${value}`))
}

/**
 * The machine the server runs on. Memory is the swapout RATE (the delta of the cumulative swapout counter between two
 * readings, scaled to 300 s) and swap in use as a share of RAM: the two numbers the dev-host heartbeat grades. The
 * first reading has no rate, and the previous sample lives in memory only. A reading that cannot be taken is an error
 * result, and admission goes on without it.
 */
export function hostReader(options: HostOptions): HostReader {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 5_000
  let last: SwapSample | null = null
  let reading: MemoryReading | null = null

  const sysctl = async (name: string): Promise<Result<string, PortError>> => {
    try {
      const out = await runProcess([options.sysctlBin, '-n', name], { timeoutMs })
      const text = out.stdout.trim()
      if (out.timedOut) return err(portError('timeout', `sysctl ${name} did not answer within ${timeoutMs} ms`))
      if (out.code !== 0 || text === '') return err(portError('unreadable', `sysctl ${name} gave no answer`))
      return ok(text)
    } catch (error) {
      if (error instanceof CannotStart) return err(portError('gone', error.message))
      throw error
    }
  }

  return {
    async memory() {
      const at = now()
      if (reading && last && at - last.at < options.minSampleMs) return ok(reading)
      const names = ['hw.pagesize', 'vm.compressor.swapper.swapouts_total', 'hw.memsize', 'vm.swapusage'] as const
      const texts: string[] = []
      for (const name of names) {
        const value = await sysctl(name)
        if (!value.ok) return value
        texts.push(value.value)
      }
      const [pageSize, pages, ram] = [
        count(names[0], texts[0] ?? ''),
        count(names[1], texts[1] ?? ''),
        count(names[2], texts[2] ?? ''),
      ]
      if (!pageSize.ok) return pageSize
      if (!pages.ok) return pages
      if (!ram.ok) return ram
      const used = swapUsedBytes(texts[3] ?? '')
      if (used === null) return err(portError('unreadable', `vm.swapusage not understood: ${texts[3]}`))
      if (ram.value <= 0) return err(portError('unreadable', 'hw.memsize is 0'))
      const sample: SwapSample = { swapoutPages: pages.value, at }
      reading = memoryReadingOf({
        before: last,
        now: sample,
        pageSize: pageSize.value,
        ramBytes: ram.value,
        swapUsedBytes: used,
      })
      last = sample
      return ok(reading)
    },

    async load() {
      const one = loadavg()[0]
      return one === undefined ? err(portError('unreadable', 'no load average')) : ok(one)
    },
  }
}
