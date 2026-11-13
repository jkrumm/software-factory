import type { SQL } from 'bun'
import * as z from 'zod'
import type { DeskStore } from '../../domains/checkpoints/ports.ts'

const At = z.object({ at: z.date() })
const Returned = z.object({ returned_at: z.date().nullable() })

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
      const [row] = await tx`SELECT returned_at FROM factory.console_visit`
      return row ? Returned.parse(row).returned_at : null
    },
  }
}
