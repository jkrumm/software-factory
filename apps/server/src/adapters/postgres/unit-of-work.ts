import { AsyncLocalStorage } from 'node:async_hooks'
import { SQL } from 'bun'
import type { UnitOfWork } from '../../app/unit-of-work.ts'
import { err, portError, type Result } from '../../kernel/result.ts'

/** Carries an error result out of `sql.begin`, which rolls back on a throw. */
class Rollback {
  constructor(readonly result: Result<never, unknown>) {}
}

/**
 * The unit of work on Postgres: the one place besides the migration runner that opens a transaction. `stores` builds
 * the stores on the transaction's connection (composed in `main.ts`). The transaction's call chain is marked, so a port
 * called inside one can be caught (`inTransaction`).
 */
export function postgresUnitOfWork<S>(sql: SQL, stores: (tx: SQL) => S): UnitOfWork<S> {
  const open = new AsyncLocalStorage<true>()
  return {
    inTransaction: () => open.getStore() === true,
    run: async <T, E>(work: (stores: S) => Promise<Result<T, E>>) => {
      try {
        const committed: Result<T, E> = await sql.begin((tx) =>
          open.run(true, async () => {
            const result = await work(stores(tx))
            if (!result.ok) throw new Rollback(result)
            return result
          }),
        )
        return committed
      } catch (error) {
        if (error instanceof Rollback) return error.result as Result<never, E>
        // A statement the server refused is a bug of ours (a constraint the code should have kept); the rest is the database gone.
        if (error instanceof SQL.PostgresError && error.code === 'ERR_POSTGRES_SERVER_ERROR') throw error
        if (error instanceof SQL.SQLError) return err(portError('gone', error.message))
        throw error
      }
    },
  }
}
