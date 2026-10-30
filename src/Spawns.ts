import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { Capacity } from "./Capacity.ts"
import { earliestReset, pickAccount, SpawnNotFound, SpawnStatus } from "./Domain.ts"
import type { NewSpawn, Reading } from "./Domain.ts"
import { Runner } from "./Runner.ts"

const Spawn = Schema.Struct({
  key: Schema.String,
  repo: Schema.String,
  prompt: Schema.String,
  status: SpawnStatus,
  account: Schema.NullOr(Schema.String),
  resumeAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  attempts: Schema.Int,
  session: Schema.NullOr(Schema.String)
})
export type Spawn = typeof Spawn.Type

export type TickOutcome = "started" | "failed" | "retry" | "waiting"

export interface TickReport {
  readonly outcomes: ReadonlyArray<{ readonly key: string; readonly outcome: TickOutcome }>
}

const BATCH = 20

export class Spawns extends Context.Service<Spawns, {
  /** Picks an account by the capacity rule; without capacity the spawn waits for the earliest reset. */
  create(input: NewSpawn): Effect.Effect<{ readonly spawn: Spawn; readonly created: boolean }>
  get(key: string): Effect.Effect<Spawn, SpawnNotFound>
  /** One pass over the due spawns. The timer in `Ticker` and the tests both call this. */
  readonly tick: Effect.Effect<TickReport>
}>()("factory/fleet/Spawns") {
  static readonly layer = Layer.effect(Spawns, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const capacity = yield* Capacity
    const runner = yield* Runner

    const columns = sql`key, repo, prompt, status, account, resume_at as "resumeAt", attempts, session`
    const asDate = (at: Option.Option<DateTime.Utc>) => Option.match(at, { onNone: () => null, onSome: DateTime.toDate })

    const findByKey = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Spawn,
      execute: (key) => sql`select ${columns} from spawns where key = ${key}`
    })

    const lockDue = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Spawn,
      // Waiting spawns are re-evaluated every tick: a new reading can free them before their resume_at.
      execute: () =>
        sql`
          select ${columns} from spawns
          where status in ('waiting', 'pending')
          order by seq
          limit ${BATCH}
          for update skip locked`
    })

    const create = Effect.fn("Spawns.create")(
      function*(input: NewSpawn) {
        return yield* sql.withTransaction(Effect.gen(function*() {
          const latest = yield* capacity.latest
          const account = pickAccount(latest)
          const resumeAt = Option.isSome(account) ? Option.none() : Option.map(earliestReset(latest), (r) => r.resetsAt)
          const inserted = yield* sql`
            insert into spawns (key, repo, prompt, status, account, resume_at)
            values (
              ${input.key}, ${input.repo}, ${input.prompt},
              ${Option.isSome(account) ? "pending" : "waiting"},
              ${Option.isSome(account) ? account.value.account : null},
              ${asDate(resumeAt)})
            on conflict (key) do nothing
            returning key`
          const spawn = yield* findByKey(input.key)
          if (Option.isNone(spawn)) return yield* Effect.die(new Error(`spawn ${input.key} vanished`))
          return { spawn: spawn.value, created: inserted.length > 0 }
        }))
      },
      Effect.orDie
    )

    const get = Effect.fn("Spawns.get")(function*(key: string) {
      const spawn = yield* findByKey(key).pipe(Effect.orDie)
      if (Option.isNone(spawn)) return yield* new SpawnNotFound({ key })
      return spawn.value
    })

    const settle = Effect.fn("Spawns.settle")(
      function*(key: string, patch: { status: "pending" | "started" | "failed"; account: string; session: string | null; error: string | null }) {
        yield* sql`
          update spawns
          set status = ${patch.status}, account = ${patch.account}, session = ${patch.session},
              error = ${patch.error}, attempts = attempts + 1
          where key = ${key}`
      },
      Effect.orDie
    )

    const defer = Effect.fn("Spawns.defer")(
      function*(key: string, resumeAt: Option.Option<DateTime.Utc>) {
        yield* sql`update spawns set resume_at = ${asDate(resumeAt)} where key = ${key}`
      },
      Effect.orDie
    )

    /** The account a spawn may start on now, or the time to look again. */
    const placement = (spawn: Spawn, latest: ReadonlyArray<Reading>, now: DateTime.Utc) => {
      if (spawn.account !== null) return Option.some(spawn.account)
      const free = pickAccount(latest)
      if (Option.isSome(free)) return Option.some(free.value.account)
      // The reset passed, so the reading is stale and the account has capacity again.
      return earliestReset(latest).pipe(
        Option.filter((reading) => DateTime.isLessThanOrEqualTo(reading.resetsAt, now)),
        Option.map((reading) => reading.account)
      )
    }

    const run = Effect.fn("Spawns.run")(function*(spawn: Spawn, account: string): Effect.fn.Return<TickOutcome> {
      return yield* runner.start({ key: spawn.key, repo: spawn.repo, prompt: spawn.prompt }).pipe(
        Effect.flatMap(({ session }) =>
          settle(spawn.key, { status: "started", account, session, error: null }).pipe(Effect.as("started" as const))
        ),
        Effect.catchTags({
          StartPermanent: (e) =>
            settle(spawn.key, { status: "failed", account, session: null, error: e.reason }).pipe(
              Effect.as("failed" as const)
            ),
          StartTransient: (e) =>
            settle(spawn.key, { status: "pending", account, session: null, error: `exit ${e.exitCode}: ${e.stderr}` }).pipe(
              Effect.as("retry" as const)
            )
        })
      )
    })

    const tick = Effect.gen(function*() {
      const now = yield* DateTime.now
      // The locks live as long as the transaction: a crash before the result is recorded rolls it back, and
      // the next tick starts the same key again, which the adapter turns into "already exists".
      const outcomes = yield* sql.withTransaction(Effect.gen(function*() {
        const due = yield* lockDue()
        const latest = yield* capacity.latest
        const outcomes: Array<{ key: string; outcome: TickOutcome }> = []
        for (const spawn of due) {
          const account = placement(spawn, latest, now)
          if (Option.isNone(account)) {
            yield* defer(spawn.key, Option.map(earliestReset(latest), (reading) => reading.resetsAt))
            outcomes.push({ key: spawn.key, outcome: "waiting" })
            continue
          }
          outcomes.push({ key: spawn.key, outcome: yield* run(spawn, account.value) })
        }
        return outcomes
      }))
      return { outcomes }
    }).pipe(Effect.orDie, Effect.withSpan("Spawns.tick"))

    return Spawns.of({ create, get, tick })
  }))
}
