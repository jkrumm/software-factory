import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { PgTest, resetDb, webApp } from "./support.ts"

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
})

const event = { key: "e1", session: "s1", kind: "session_started", at: "2026-10-30T12:00:00.000Z" }

layer(PgTest)("http", (it) => {
  it.effect("POST /events stores once, validates, and GET /sessions/:id derives the state", () =>
    Effect.gen(function*() {
      yield* resetDb
      const app = yield* webApp

      const first = yield* app("/events", json("POST", event))
      assert.strictEqual(first.status, 201)
      assert.deepStrictEqual(yield* Effect.promise(() => first.json()), { duplicate: false })

      const again = yield* app("/events", json("POST", { ...event, kind: "session_ended" }))
      assert.strictEqual(again.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => again.json()), { duplicate: true })

      const session = yield* app("/sessions/s1")
      assert.strictEqual(session.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => session.json()), {
        id: "s1",
        state: "starting",
        lastEventAt: "2026-10-30T12:00:00.000Z"
      })

      assert.strictEqual((yield* app("/sessions/unknown")).status, 404)
      assert.strictEqual((yield* app("/events", json("POST", { ...event, key: "e2", kind: "nope" }))).status, 400)
      assert.strictEqual((yield* app("/events", json("POST", { ...event, key: "e3", at: "yesterday" }))).status, 400)
      assert.strictEqual((yield* app("/events", json("POST", { session: "s1" }))).status, 400)
      assert.strictEqual((yield* app("/events", { method: "POST", body: "{not json" })).status, 400)
    }))

  it.effect("capacity, spawns and their lookups", () =>
    Effect.gen(function*() {
      yield* resetDb
      const app = yield* webApp
      const body = (response: Response) => Effect.promise(() => response.json())

      const spawn = { key: "k1", repo: "/tmp/repo", prompt: "go" }
      const waiting = yield* app("/spawns", json("POST", spawn))
      assert.strictEqual(waiting.status, 201)
      assert.deepStrictEqual(yield* body(waiting), {
        key: "k1",
        status: "waiting",
        account: null,
        resumeAt: null,
        attempts: 0,
        session: null
      })

      const reading = yield* app(
        "/capacity/main",
        json("PUT", { weeklyUsed: 10, fiveHourUsed: 5, resetsAt: "2026-10-30T17:00:00.000Z" })
      )
      assert.strictEqual(reading.status, 200)

      const withCapacity = yield* app("/spawns", json("POST", { ...spawn, key: "k2" }))
      assert.strictEqual(withCapacity.status, 201)
      assert.deepStrictEqual(yield* body(withCapacity), {
        key: "k2",
        status: "pending",
        account: "main",
        resumeAt: null,
        attempts: 0,
        session: null
      })

      const repeated = yield* app("/spawns", json("POST", { ...spawn, key: "k2", prompt: "other" }))
      assert.strictEqual(repeated.status, 200)
      assert.strictEqual(((yield* body(repeated)) as { status: string }).status, "pending")

      const fetched = yield* app("/spawns/k1")
      assert.strictEqual(fetched.status, 200)
      assert.strictEqual(((yield* body(fetched)) as { status: string }).status, "waiting")

      assert.strictEqual((yield* app("/spawns/missing")).status, 404)
      assert.strictEqual((yield* app("/spawns", json("POST", { key: "k3" }))).status, 400)
      assert.strictEqual(
        (yield* app("/capacity/main", json("PUT", { weeklyUsed: -1, fiveHourUsed: 5, resetsAt: "2026-10-30T17:00:00Z" })))
          .status,
        400
      )
    }))
})
