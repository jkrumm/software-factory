import type { PortError, Result } from '../kernel/result.ts'

/**
 * One transaction over the stores a use case needs. `S` is the stores, composed in `main.ts`: a use case asks for the
 * slice it reads (`UnitOfWork<{ work: WorkStore }>`), and a domain package adds its own store beside `work`.
 *
 * `run` commits when `work` answers ok and rolls back when it answers an error, which comes back as it was; a database
 * that fails is a `PortError`. Ports are never called inside: `inTransaction` says whether this call chain is in one.
 */
export interface UnitOfWork<S> {
  run<T, E>(work: (stores: S) => Promise<Result<T, E>>): Promise<Result<T, E | PortError>>
  inTransaction(): boolean
}
