import { PgClient } from "@effect/sql-pg"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { deriveState, EventKind, SessionNotFound, SessionState } from "./Domain.ts"
import type { NewEvent } from "./Domain.ts"

export interface SessionView {
  readonly id: string
  readonly state: SessionState
  readonly lastEventAt: DateTime.Utc
}

export class Events extends Context.Service<Events, {
  /** Stores the event; a repeated key changes nothing and reports `duplicate`. */
  ingest(event: NewEvent): Effect.Effect<{ readonly duplicate: boolean }>
  session(id: string): Effect.Effect<SessionView, SessionNotFound>
}>()("factory/fleet/Events") {
  static readonly layer = Layer.effect(Events, Effect.gen(function*() {
    const sql = yield* PgClient.PgClient

    const ordered = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ kind: EventKind, at: Schema.DateTimeUtcFromDate }),
      execute: (session) => sql`select kind, at from session_events where session = ${session} order by at, seq`
    })

    const ingest = Effect.fn("Events.ingest")(
      function*(event: NewEvent) {
        const payload = event.payload === undefined ? null : sql.json(event.payload)
        const inserted = yield* sql`
          insert into session_events (key, session, kind, at, payload)
          values (${event.key}, ${event.session}, ${event.kind}, ${DateTime.toDate(event.at)}, ${payload})
          on conflict (key) do nothing
          returning seq`
        return { duplicate: inserted.length === 0 }
      },
      Effect.orDie
    )

    const session = Effect.fn("Events.session")(
      function*(id: string) {
        const rows = yield* ordered(id).pipe(Effect.orDie)
        const last = rows.at(-1)
        if (last === undefined) return yield* new SessionNotFound({ id })
        return { id, state: deriveState(rows.map((row) => row.kind)), lastEventAt: last.at }
      }
    )

    return Events.of({ ingest, session })
  }))
}
