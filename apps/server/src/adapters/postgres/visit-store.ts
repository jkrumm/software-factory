import type { SQL } from 'bun'
import * as z from 'zod'
import type { VisitStore } from '../../app/visit.ts'

const Row = z.object({ seen_at: z.date(), since_at: z.date(), returned_at: z.date().nullable() })

export function postgresVisitStore(tx: SQL): VisitStore {
  return {
    async marker() {
      const rows: unknown[] = await tx`SELECT seen_at, since_at, returned_at FROM factory.console_visit FOR UPDATE`
      if (rows.length === 0) return null
      const row = Row.parse(rows[0])
      return { seenAt: row.seen_at, sinceAt: row.since_at, returnedAt: row.returned_at }
    },

    async save(marker) {
      await tx`
        INSERT INTO factory.console_visit (id, seen_at, since_at, returned_at)
        VALUES (true, ${marker.seenAt}, ${marker.sinceAt}, ${marker.returnedAt})
        ON CONFLICT (id) DO UPDATE
        SET seen_at = EXCLUDED.seen_at, since_at = EXCLUDED.since_at, returned_at = EXCLUDED.returned_at`
    },
  }
}
