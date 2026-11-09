import type { SQL } from 'bun'

const STEP_MS = 5 * 60_000
const POINTS = (24 * 3_600_000) / STEP_MS

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
    await sql`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s)
      VALUES (${at}, ${load}, ${memory}, ${swap}, ${swapout})`
  }
}
