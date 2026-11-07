import type { DoorReport } from '@software-factory/contract'
import type { SQL } from 'bun'

/** A source refused this many times since its last accepted message is a health line (while the last refusal is recent). */
export const DOOR_SOURCE_REFUSED_MIN = 3
/** A source with no accepted message for this long is a health line (a stale token, a monitor that was removed). */
export const DOOR_SOURCE_QUIET_MS = 14 * 24 * 3_600_000

/** A source that posted a message the door accepted: the refusals are over. The server's clock. */
export async function markAccepted(sql: SQL, source: string, now: Date): Promise<void> {
  await sql`
    INSERT INTO factory.door_sources (source, first_seen, last_accepted) VALUES (${source}, ${now}, ${now})
    ON CONFLICT (source) DO UPDATE SET last_accepted = EXCLUDED.last_accepted, refused = 0, refused_since = NULL`
}

/** `POST /intake/report`: what the door says about its sources (design.md §11). */
export async function recordDoorReport(sql: SQL, report: DoorReport, now: Date): Promise<void> {
  if (report.kind === 'accepted') return markAccepted(sql, report.source, now)
  if (report.kind === 'start') {
    for (const source of report.sources) {
      await sql`INSERT INTO factory.door_sources (source, first_seen) VALUES (${source}, ${now}) ON CONFLICT (source) DO NOTHING`
    }
    // A source the door no longer holds a token for is retired: its row would be a silence line for ever.
    await sql`DELETE FROM factory.door_sources WHERE source NOT IN ${sql(report.sources)}`
    return
  }
  await sql`
    INSERT INTO factory.door_sources (source, first_seen, refused, refused_since, last_refused)
    VALUES (${report.source}, ${now}, 1, ${now}, ${now})
    ON CONFLICT (source) DO UPDATE
      SET refused_since = CASE WHEN factory.door_sources.refused = 0 THEN EXCLUDED.refused_since
                               ELSE factory.door_sources.refused_since END,
          refused = factory.door_sources.refused + 1, last_refused = EXCLUDED.last_refused`
}

const minute = (at: Date): string => `${at.toISOString().slice(0, 16)}Z`

/**
 * The health lines of the door's sources, derived at read: a source refused at least three times with the last refusal within
 * `finishedMs` (health.ts's FINISHED_HEALTH_MS, passed in: health.ts imports this file), and a source with nothing accepted for 14 days.
 */
export async function doorSourceLines(sql: SQL, now: Date, finishedMs: number): Promise<string[]> {
  const rows: {
    source: string
    first_seen: Date
    last_accepted: Date | null
    refused: number
    refused_since: Date | null
    last_refused: Date | null
  }[] =
    await sql`SELECT source, first_seen, last_accepted, refused, refused_since, last_refused FROM factory.door_sources ORDER BY source`
  const lines: string[] = []
  for (const row of rows) {
    if (row.refused >= DOOR_SOURCE_REFUSED_MIN && row.refused_since && row.last_refused) {
      if (now.getTime() - row.last_refused.getTime() <= finishedMs) {
        lines.push(
          `door source ${row.source}: ${row.refused} POSTs refused since ${minute(row.refused_since)} (last ${minute(row.last_refused)}), none accepted since`,
        )
      }
    }
    const quiet = now.getTime() - (row.last_accepted ?? row.first_seen).getTime()
    if (quiet > DOOR_SOURCE_QUIET_MS) {
      lines.push(`door source ${row.source}: nothing accepted for ${Math.floor(quiet / 86_400_000)} days`)
    }
  }
  return lines
}
