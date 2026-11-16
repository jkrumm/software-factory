import type { SQL } from 'bun'

const STEP_MS = 5 * 60_000
const POINTS = (24 * 3_600_000) / STEP_MS
const GIB = 1024 ** 3
const RAM = 64 * GIB
const SWAP_TOTAL = 32 * GIB

/**
 * The host's last 24 hours at 5-minute spacing, a deterministic curve with a busy spell and a few gaps (a reading that
 * failed is null), so the Live popover has a chart without waiting a minute. The host loop is off in the e2e world.
 */
export async function seedHost(sql: SQL, now = new Date()): Promise<void> {
  for (let i = POINTS; i >= 0; i--) {
    const at = new Date(now.getTime() - i * STEP_MS)
    const phase = (i / POINTS) * Math.PI * 4
    const busy = i > 90 && i < 130 ? 1 : 0
    const gap = i > 0 && i % 37 === 0
    const load = gap ? null : Math.round((3 + 2 * Math.sin(phase) + busy * 9) * 100) / 100
    const memory = gap ? null : Math.round((62 + 8 * Math.sin(phase / 2) + busy * 12) * 10) / 10
    const swap = Math.round((18 + (POINTS - i) * 0.05 + busy * 6) * 10) / 10
    const swapout = busy ? 640 + (i % 7) * 20 : (i % 5) * 4
    // the amounts the host loop stores beside the shares, and the header's CPU split (user and system, percent of all cores)
    const memoryBytes = memory === null ? null : Math.round((memory / 100) * RAM)
    const user = load === null ? null : Math.min(70, Math.round(load * 6 * 10) / 10)
    const system = load === null ? null : Math.min(15, Math.round(load * 10) / 10)
    await sql`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, load_ceiling,
        ram_bytes, memory_used_bytes, swap_used_bytes, swap_total_bytes, cpu_user_pct, cpu_sys_pct)
      VALUES (${at}, ${load}, ${memory}, ${swap}, ${swapout}, 36, ${RAM}, ${memoryBytes}, ${Math.round((swap / 100) * RAM)},
        ${SWAP_TOTAL}, ${user}, ${system})`
  }
}
