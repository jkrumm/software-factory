/**
 * The boot grace (Issue 1039). Right after the host boots, hc-resume brings every session back at once and the host
 * is busy for minutes; the factory has no say in that, but it can start nothing new on top of it. While the uptime is
 * under `BOOT_GRACE_MS`: no new lead until the load has stayed under a quarter of its ceiling for five minutes of
 * samples taken since the boot and the newest sample's memory is under `BOOT_MEMORY_PCT`; then at most one lead per
 * `BOOT_ADMIT_GAP_MS`. Leads that resume are not touched: they hold their seats as always.
 */
export const BOOT_GRACE_MS = 30 * 60_000
/** Minute samples, since the boot, that must all be calm. */
export const BOOT_CALM_SAMPLES = 5
/** None of them may be older than this: a gap in the minute samples says nothing. */
export const BOOT_SAMPLE_MAX_AGE_MS = 6 * 60_000
/** The newest sample's memory in use must be below this share of RAM, percent. */
export const BOOT_MEMORY_PCT = 80
/** Once calm, one new lead per this long until the grace ends. */
export const BOOT_ADMIT_GAP_MS = 2 * 60_000

/** One minute sample of the host. */
export interface BootSample {
  at: Date
  load: number | null
  memoryUsedPct: number | null
}

export interface BootInputs {
  /** how long the host has been up */
  uptimeMs: number
  /** the minute samples, newest first */
  samples: readonly BootSample[]
  /** the newest admission's time (any lead's), null: none */
  lastAdmittedAt: Date | null
  /** the 1-minute load at this pass, null: not read */
  load: number | null
  loadCeiling: number
}

export interface BootRefusal {
  message: string
  /** when the gap between two admissions ends; null when only a reading can end the reason */
  opensAt: Date | null
}

const minutes = (ms: number): number => Math.floor(ms / 60_000)

/** The refusal of a new lead while the host is still booting, or null: the grace is over, or the host is calm and the gap is kept. */
export function bootRefusal(input: BootInputs, now: Date): BootRefusal | null {
  if (input.uptimeMs >= BOOT_GRACE_MS) return null
  const since = `host booted ${minutes(input.uptimeMs)} min ago`
  const quarter = input.loadCeiling / 4
  const bootAt = now.getTime() - input.uptimeMs
  const newest = input.samples[0]
  const window = input.samples.slice(0, BOOT_CALM_SAMPLES)
  const sampled =
    window.length === BOOT_CALM_SAMPLES &&
    window.every((s) => s.at.getTime() >= bootAt && now.getTime() - s.at.getTime() <= BOOT_SAMPLE_MAX_AGE_MS)
  if (!sampled)
    return { message: `${since}: waiting for ${BOOT_CALM_SAMPLES} minutes of samples since the boot`, opensAt: null }
  const hot = window.find((s) => s.load === null || s.load >= quarter)
  if (hot || (input.load !== null && input.load >= quarter)) {
    const load = hot ? hot.load : input.load
    return {
      message: `${since}: the load must stay under ${quarter} (a quarter of ${input.loadCeiling}) for ${BOOT_CALM_SAMPLES} min, it is ${load === null ? 'unknown' : Math.round(load * 10) / 10}`,
      opensAt: null,
    }
  }
  const used = newest?.memoryUsedPct ?? null
  if (used === null || used >= BOOT_MEMORY_PCT) {
    return {
      message: `${since}: memory in use must be under ${BOOT_MEMORY_PCT}%, it is ${used === null ? 'unknown' : `${used}%`}`,
      opensAt: null,
    }
  }
  if (input.lastAdmittedAt) {
    const opens = new Date(input.lastAdmittedAt.getTime() + BOOT_ADMIT_GAP_MS)
    if (opens > now) {
      return {
        message: `${since}: one new lead per ${minutes(BOOT_ADMIT_GAP_MS)} min until it has been up ${minutes(BOOT_GRACE_MS)} min`,
        opensAt: opens,
      }
    }
  }
  return null
}
