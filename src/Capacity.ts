import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { NewReading, Reading } from "./Domain.ts"

export class Capacity extends Context.Service<Capacity, {
  record(account: string, reading: NewReading): Effect.Effect<void>
  /** The newest reading of every account. */
  readonly latest: Effect.Effect<ReadonlyArray<Reading>>
}>()("factory/fleet/Capacity") {
  static readonly layer = Layer.effect(Capacity, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const latestPerAccount = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        account: Schema.String,
        weeklyUsed: Schema.Finite,
        fiveHourUsed: Schema.Finite,
        resetsAt: Schema.DateTimeUtcFromDate
      }),
      execute: () =>
        sql`
          select distinct on (account)
            account, weekly_used as "weeklyUsed", five_hour_used as "fiveHourUsed", resets_at as "resetsAt"
          from capacity_readings
          order by account, seq desc`
    })

    const record = Effect.fn("Capacity.record")(
      function*(account: string, reading: NewReading) {
        yield* sql`
          insert into capacity_readings (account, weekly_used, five_hour_used, resets_at)
          values (${account}, ${reading.weeklyUsed}, ${reading.fiveHourUsed}, ${DateTime.toDate(reading.resetsAt)})`
      },
      Effect.orDie
    )

    const latest = latestPerAccount().pipe(Effect.orDie, Effect.withSpan("Capacity.latest"))

    return Capacity.of({ record, latest })
  }))
}
