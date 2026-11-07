import type { DoorSourceRow, UnroutedRow } from './ports.ts'

/** A source refused this many times since its last accepted message is a line (while the last refusal is recent). */
export const DOOR_SOURCE_REFUSED_MIN = 3
/** A source with no accepted message for this long is a line (a stale token, a monitor that was removed). */
export const DOOR_SOURCE_QUIET_MS = 14 * 24 * 3_600_000

const minute = (at: Date): string => `${at.toISOString().slice(0, 16)}Z`

/**
 * The health lines of the door's sources, derived at read: a source refused at least three times with the last refusal
 * within `finishedMs`, and a source with nothing accepted for 14 days. Nothing here is stored as a transition.
 */
export function doorSourceLines(rows: readonly DoorSourceRow[], now: Date, finishedMs: number): string[] {
  const lines: string[] = []
  for (const row of rows) {
    if (row.refused >= DOOR_SOURCE_REFUSED_MIN && row.refusedSince && row.lastRefused) {
      if (now.getTime() - row.lastRefused.getTime() <= finishedMs) {
        lines.push(
          `door source ${row.source}: ${row.refused} POSTs refused since ${minute(row.refusedSince)} (last ${minute(row.lastRefused)}), none accepted since`,
        )
      }
    }
    const quiet = now.getTime() - (row.lastAccepted ?? row.firstSeen).getTime()
    if (quiet > DOOR_SOURCE_QUIET_MS) {
      lines.push(`door source ${row.source}: nothing accepted for ${Math.floor(quiet / 86_400_000)} days`)
    }
  }
  return lines
}

const since = (ms: number): string =>
  ms < 2 * 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`

/** A monitor that is down past the grace with no route, as a line: it is there while the monitor is down and gone at its `up` or a route. */
export function unroutedLines(rows: readonly UnroutedRow[], now: Date, graceMs: number): string[] {
  return rows
    .filter(
      (row) =>
        row.status === 'down' && !row.group && row.downSince && now.getTime() - row.downSince.getTime() >= graceMs,
    )
    .map((row) => {
      const name = row.monitor.length > 80 ? `${row.monitor.slice(0, 79)}…` : row.monitor
      const state = row.filedIssue ? `filed as ${row.filedIssue}` : 'to be filed'
      return `monitor ${row.source}/${name} down ${since(now.getTime() - (row.downSince as Date).getTime())} with no route, ${state}`
    })
}
