import { SQL } from 'bun'

/** A database answer slower than this counts as no answer for `/health`. */
const PING_TIMEOUT_MS = 2_000

/** The pool every adapter shares. `DATABASE_URL` comes from `secrets-run`, never a tracked file. */
export function connect(url: string): SQL {
  return new SQL(url, { max: 8 })
}

/** Null when the database answers, else why it did not. */
export async function ping(sql: SQL): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`the database did not answer within ${PING_TIMEOUT_MS} ms`), PING_TIMEOUT_MS)
  })
  const query = sql`SELECT 1`.then(
    () => null,
    (error: unknown) => `the database failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  try {
    return await Promise.race([query, timeout])
  } finally {
    clearTimeout(timer)
  }
}
