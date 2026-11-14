import type { SQL } from 'bun'
import * as z from 'zod'
import type { DeskStore } from '../../domains/checkpoints/ports.ts'

const At = z.object({ at: z.date() })
const Returned = z.object({ returned_at: z.date().nullable() })
const Presence = z.object({ macbook_up: z.boolean(), back_at: z.date().nullable() })

export function postgresDeskStore(tx: SQL): DeskStore {
  return {
    async lastPassAt() {
      const [row] = await tx`SELECT at FROM factory.desk_pass`
      return row ? At.parse(row).at : null
    },

    async recordPass(at) {
      await tx`
        INSERT INTO factory.desk_pass (id, at) VALUES (true, ${at})
        ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at`
    },

    async returnedAt() {
      const [visit] = await tx`SELECT returned_at FROM factory.console_visit`
      const [macbook] = await tx`SELECT macbook_up, back_at FROM factory.desk_presence`
      const times = [visit ? Returned.parse(visit).returned_at : null, macbook ? Presence.parse(macbook).back_at : null]
        .filter((at): at is Date => at !== null)
        .map((at) => at.getTime())
      return times.length === 0 ? null : new Date(Math.max(...times))
    },

    async macbookUp() {
      const [row] = await tx`SELECT macbook_up, back_at FROM factory.desk_presence`
      return row ? Presence.parse(row).macbook_up : null
    },

    async setMacbook(up, backAt) {
      await tx`
        INSERT INTO factory.desk_presence (id, macbook_up, back_at) VALUES (true, ${up}, ${backAt})
        ON CONFLICT (id) DO UPDATE SET macbook_up = EXCLUDED.macbook_up,
          back_at = COALESCE(EXCLUDED.back_at, factory.desk_presence.back_at)`
    },
  }
}
