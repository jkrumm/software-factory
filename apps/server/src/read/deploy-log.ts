import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThroughputModel } from '@software-factory/contract'

export type DeployDay = ThroughputModel['deploys']['days'][number]

const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (start|end) pid=(\d+)(.*)$/

/**
 * The days of `data/deploys.log` (one `start` and one `end` line per `scripts/deploy.sh`, by pid) that fall in
 * `[from, to)`, by the day each deploy ended (UTC), oldest first. A deploy that restarted the server carries
 * `unreachable_s=N` on its `end` line, the seconds from stopping the old process to `/health` at the new sha; one that
 * found its commit live says `skipped=live` and restarted nothing; an `end` from before the figure existed and with
 * `rc=0` counts as a restart whose length nobody measured. A `start` with no `end` yet is still running and not counted.
 */
export function deployDays(text: string, window: { from: Date; to: Date }): DeployDay[] {
  const days = new Map<string, DeployDay>()
  for (const line of text.split('\n')) {
    const match = LINE.exec(line)
    if (match?.[2] !== 'end') continue
    const [, at = '', , , rest = ''] = match
    const ended = new Date(at)
    if (ended < window.from || ended >= window.to) continue
    const rc = Number(/\brc=(\d+)/.exec(rest)?.[1] ?? 0)
    const seconds = /\bunreachable_s=(\d+)/.exec(rest)?.[1]
    const skipped = /\bskipped=live\b/.test(rest)
    const stopped = seconds !== undefined || (!skipped && rc === 0)
    const day = days.get(at.slice(0, 10)) ?? {
      day: at.slice(0, 10),
      deploys: 0,
      restarts: 0,
      skipped: 0,
      failed: 0,
      unreachableSeconds: 0,
      longestSeconds: 0,
    }
    day.deploys += 1
    if (skipped) day.skipped += 1
    if (rc !== 0) day.failed += 1
    if (stopped) day.restarts += 1
    if (seconds !== undefined) {
      day.unreachableSeconds += Number(seconds)
      day.longestSeconds = Math.max(day.longestSeconds, Number(seconds))
    }
    days.set(day.day, day)
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** `deployDays` of the log under `dataDir`; a log that is not there (a dev server, a new host) has no days. */
export async function readDeployDays(
  dataDir: string | undefined,
  window: { from: Date; to: Date },
): Promise<DeployDay[]> {
  if (!dataDir) return []
  const text = await readFile(join(dataDir, 'deploys.log'), 'utf8').catch(() => '')
  return deployDays(text, window)
}
