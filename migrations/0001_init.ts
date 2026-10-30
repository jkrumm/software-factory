import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    create table session_events (
      seq bigserial primary key,
      key text not null unique,
      session text not null,
      kind text not null check (kind in ('session_started', 'turn_started', 'turn_ended', 'limit_stop', 'session_ended')),
      at timestamptz not null,
      payload jsonb
    )
  `
  yield* sql`create index session_events_order on session_events (session, at, seq)`

  yield* sql`
    create table capacity_readings (
      seq bigserial primary key,
      account text not null,
      weekly_used double precision not null,
      five_hour_used double precision not null,
      resets_at timestamptz not null
    )
  `
  yield* sql`create index capacity_readings_latest on capacity_readings (account, seq desc)`

  yield* sql`
    create table spawns (
      seq bigserial not null unique,
      key text primary key,
      repo text not null,
      prompt text not null,
      status text not null check (status in ('waiting', 'pending', 'started', 'failed')),
      account text,
      resume_at timestamptz,
      attempts integer not null default 0,
      session text,
      error text
    )
  `
  yield* sql`create index spawns_open on spawns (seq) where status in ('waiting', 'pending')`
})
