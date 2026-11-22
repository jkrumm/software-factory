import type { SQL } from 'bun'
import type { RefusalSink } from '../../api/refusals.ts'

/**
 * Writes each refused request as one row (`factory.api_refusals`): one INSERT on the pool, never awaited by the request it
 * counts, so a slow or failing database costs the answer nothing; the failure goes to `log`.
 */
export const postgresRefusalSink =
  (sql: SQL, log: (message: string) => void): RefusalSink =>
  (refusal) => {
    void (async () => {
      try {
        await sql`
          INSERT INTO factory.api_refusals (at, operation, caller, status, fields)
          VALUES (${refusal.at}, ${refusal.operation}, ${refusal.caller}, ${refusal.status},
            ${JSON.stringify(refusal.fields)}::text::jsonb)`
      } catch (error) {
        log(`refusal not counted: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }
