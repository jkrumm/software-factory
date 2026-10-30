import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Capacity } from "./Capacity.ts"
import { NewEvent, NewReading, NewSpawn } from "./Domain.ts"
import { Events } from "./Events.ts"
import type { Spawn } from "./Spawns.ts"
import { Spawns } from "./Spawns.ts"

const reply = (body: unknown, status = 200) => HttpServerResponse.json(body, { status }).pipe(Effect.orDie)

const badRequest = (error: { readonly message: string }) => reply({ error: error.message }, 400)
const notFound = (error: { readonly _tag: string }) => reply({ error: error._tag }, 404)

const iso = Option.match({ onNone: () => null, onSome: DateTime.formatIso })

const spawnBody = (spawn: Spawn) => ({
  key: spawn.key,
  status: spawn.status,
  account: spawn.account,
  resumeAt: iso(Option.fromNullishOr(spawn.resumeAt)),
  attempts: spawn.attempts,
  session: spawn.session
})

const Id = Schema.Struct({ id: Schema.NonEmptyString })
const Key = Schema.Struct({ key: Schema.NonEmptyString })
const Account = Schema.Struct({ account: Schema.NonEmptyString })

const postEvent = Effect.gen(function*() {
  const events = yield* Events
  const event = yield* HttpServerRequest.schemaBodyJson(NewEvent)
  const { duplicate } = yield* events.ingest(event)
  return yield* reply({ duplicate }, duplicate ? 200 : 201)
}).pipe(Effect.catchTags({ SchemaError: badRequest, HttpServerError: badRequest }))

const getSession = Effect.gen(function*() {
  const events = yield* Events
  const { id } = yield* HttpRouter.schemaPathParams(Id)
  const session = yield* events.session(id)
  return yield* reply({ id: session.id, state: session.state, lastEventAt: DateTime.formatIso(session.lastEventAt) })
}).pipe(Effect.catchTags({ SchemaError: badRequest, SessionNotFound: notFound }))

const postSpawn = Effect.gen(function*() {
  const spawns = yield* Spawns
  const input = yield* HttpServerRequest.schemaBodyJson(NewSpawn)
  const { spawn, created } = yield* spawns.create(input)
  return yield* reply(spawnBody(spawn), created ? 201 : 200)
}).pipe(Effect.catchTags({ SchemaError: badRequest, HttpServerError: badRequest }))

const getSpawn = Effect.gen(function*() {
  const spawns = yield* Spawns
  const { key } = yield* HttpRouter.schemaPathParams(Key)
  return yield* reply(spawnBody(yield* spawns.get(key)))
}).pipe(Effect.catchTags({ SchemaError: badRequest, SpawnNotFound: notFound }))

const putCapacity = Effect.gen(function*() {
  const capacity = yield* Capacity
  const { account } = yield* HttpRouter.schemaPathParams(Account)
  const reading = yield* HttpServerRequest.schemaBodyJson(NewReading)
  yield* capacity.record(account, reading)
  return yield* reply({ account, ...reading, resetsAt: DateTime.formatIso(reading.resetsAt) })
}).pipe(Effect.catchTags({ SchemaError: badRequest, HttpServerError: badRequest }))

export const Routes = Layer.mergeAll(
  HttpRouter.add("POST", "/events", postEvent),
  HttpRouter.add("GET", "/sessions/:id", getSession),
  HttpRouter.add("POST", "/spawns", postSpawn),
  HttpRouter.add("GET", "/spawns/:key", getSpawn),
  HttpRouter.add("PUT", "/capacity/:account", putCapacity)
)
