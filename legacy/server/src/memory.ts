/**
 * The host's memory pressure, for admission (docs/design.md, "The memory hold"). `memory_pressure` and the free-page share lie here (65 % free
 * with swap nearly full), so the reading is the two numbers the dev-host heartbeat grades (`dotfiles/docs/devhost-health.md`, "Memory storm
 * detection"): the swapout RATE, from the cumulative `vm.compressor.swapper.swapouts_total`, and swap in use as a share of RAM.
 */

/** What one reading says: swapped-out data in the last 300 s (MiB, by the counter's delta scaled to the window) and swap in use against RAM. */
export interface MemoryReading {
  swapoutMbPer300s: number
  swapUsedPct: number
}

/** The ceilings, `FACTORY_SWAPOUT_CEILING_MB` and `FACTORY_SWAP_CEILING_PCT`: a reading above either holds a new Issue lead. */
export interface MemoryCeilings {
  swapoutMbPer300s: number
  swapUsedPct: number
}

/** `FACTORY_SWAPOUT_CEILING_MB`: the heartbeat's FAIL line, 2 GiB per 300 s. */
export const DEFAULT_SWAPOUT_CEILING_MB = 2048

/** `FACTORY_SWAP_CEILING_PCT`: the heartbeat's FAIL line, 75 % of RAM. Swap does not drain when its cause is gone, so only a leak-sized share counts. */
export const DEFAULT_SWAP_CEILING_PCT = 75

/** The rule: a new Issue lead waits while a reading is above either ceiling. The reading is passed in; running leads are never touched. */
export const heldByMemory = (reading: MemoryReading, ceilings: MemoryCeilings): boolean =>
  reading.swapoutMbPer300s > ceilings.swapoutMbPer300s || reading.swapUsedPct > ceilings.swapUsedPct

/** A counter delta over less than this is too short a window to scale: the last reading stands. */
export const MIN_SAMPLE_MS = 30_000

const WINDOW_S = 300
const MIB = 1024 * 1024
const UNITS: Record<string, number> = { K: 1024, M: MIB, G: 1024 * MIB }

/** `sysctl -n <name>`; a failure to run, or an empty answer, throws. */
export function sysctl(name: string): string {
  const out = Bun.spawnSync(['/usr/sbin/sysctl', '-n', name])
  const text = out.stdout.toString().trim()
  if (out.exitCode !== 0 || text === '') throw new Error(`sysctl ${name} gave no answer`)
  return text
}

/** The swap in use, in bytes, from `vm.swapusage` (`total = 10240.00M  used = 9012.25M  free = …`). */
export function swapUsedBytes(swapusage: string): number {
  const match = /used\s*=\s*([\d.]+)\s*([KMG])/.exec(swapusage)
  const unit = match?.[2] ? UNITS[match[2]] : undefined
  if (!match?.[1] || unit === undefined) throw new Error(`vm.swapusage not understood: ${swapusage}`)
  return Number(match[1]) * unit
}

const count = (name: string, value: string): number => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} not a number: ${value}`)
  return n
}

/**
 * Reads the two numbers. The swapout counter is cumulative since boot, so the rate is the delta between two readings; the first reading
 * has no rate (0), a counter that fell (a reboot) starts over, and readings closer than `MIN_SAMPLE_MS` return the last one, so many
 * admissions in one pass cost one sample. In memory: a restart of the server takes a first reading again.
 */
export class SwapSampler {
  private last: { pages: number; at: number } | null = null
  private reading: MemoryReading | null = null

  constructor(
    private readonly read: (name: string) => string = sysctl,
    private readonly now: () => number = Date.now,
  ) {}

  sample(): MemoryReading {
    const at = this.now()
    if (this.reading && this.last && at - this.last.at < MIN_SAMPLE_MS) return this.reading
    const pageSize = count('hw.pagesize', this.read('hw.pagesize'))
    const pages = count('swapouts_total', this.read('vm.compressor.swapper.swapouts_total'))
    const ram = count('hw.memsize', this.read('hw.memsize'))
    const used = swapUsedBytes(this.read('vm.swapusage'))
    if (ram <= 0) throw new Error('hw.memsize is 0')
    const before = this.last
    const seconds = before ? (at - before.at) / 1000 : 0
    const rate =
      before && pages >= before.pages && seconds > 0
        ? (((pages - before.pages) * pageSize) / MIB) * (WINDOW_S / seconds)
        : 0
    this.last = { pages, at }
    this.reading = { swapoutMbPer300s: Math.round(rate), swapUsedPct: Math.round((used / ram) * 1000) / 10 }
    return this.reading
  }
}

const machine = new SwapSampler()

/** The reading of this host. */
export const machineMemory = (): MemoryReading => machine.sample()

/** What the status shows: the failure of the last reading, and what the last hold read; each gone at the next reading that clears it. */
const state: { failure: string | null; held: string | null } = { failure: null, held: null }

/** For a test: forget what the last reading said. */
export function resetMemoryState(): void {
  state.failure = null
  state.held = null
}

const describe = (r: MemoryReading, c: MemoryCeilings): string =>
  `swapouts ${r.swapoutMbPer300s} MiB/300s (ceiling ${c.swapoutMbPer300s}), swap ${r.swapUsedPct}% of RAM (ceiling ${c.swapUsedPct}%)`

/**
 * Whether a new lead is held for memory now. A reading that cannot be taken fails open (the lead is admitted, the queue goes on) and
 * leaves a health line saying so; the next admission reads again.
 */
export function memoryHeld(ceilings: MemoryCeilings, read: () => MemoryReading = machineMemory): boolean {
  let reading: MemoryReading
  try {
    reading = read()
  } catch (err) {
    state.failure = err instanceof Error ? err.message : String(err)
    state.held = null
    return false
  }
  state.failure = null
  const held = heldByMemory(reading, ceilings)
  state.held = held ? describe(reading, ceilings) : null
  return held
}

/** What the last hold read, for the health line; none while nothing is held. */
export const memoryHeldDetail = (): string | null => state.held

/** The health line for a reading that failed: there until a reading succeeds. */
export function memoryFailureLines(): string[] {
  return state.failure === null
    ? []
    : [`memory reading failed (${state.failure}): new leads are admitted without it, the next admission reads again`]
}
