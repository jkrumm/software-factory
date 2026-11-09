import type { SQL } from 'bun'
import * as z from 'zod'
import type { VisitStore } from '../../app/visit.ts'

const Row = z.object({ seen_at: z.date(), since_at: z.date() })

export function postgresVisitStore(tx: SQL): VisitStore {
  return {
    async marker() {
      const rows: unknown[] = await tx`SELECT seen_at, since_at FROM factory.console_visit FOR UPDATE`
      if (rows.length === 0) return null
      const row = Row.parse(rows[0])
      return { seenAt: row.seen_at, sinceAt: row.since_at }
    },

    async save(marker) {
      await tx`
        INSERT INTO factory.console_visit (id, seen_at, since_at) VALUES (true, ${marker.seenAt}, ${marker.sinceAt})
        ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at, since_at = EXCLUDED.since_at`
    },
  }
}
