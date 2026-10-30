import { assert, describe, it, layer } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { deriveState } from "../src/Domain.ts"
import type { EventKind, NewEvent } from "../src/Domain.ts"
import { Events } from "../src/Events.ts"
import { fleetWith, PgTest, resetDb } from "./support.ts"
import { Runner } from "../src/Runner.ts"

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 12, minute))

const event = (key: string, kind: EventKind, minute: number, session = "s1"): NewEvent => ({
  key,
  session,
  kind,
  at: at(minute)
})

describe("deriveState", () => {
  const cases: ReadonlyArray<readonly [ReadonlyArray<EventKind>, string]> = [
    [["session_started"], "starting"],
    [["session_started", "turn_started"], "working"],
    [["session_started", "turn_started", "turn_ended"], "idle"],
    [["session_started", "turn_started", "turn_ended", "turn_started"], "working"],
    [["session_started", "turn_started", "limit_stop"], "walled"],
    [["session_started", "turn_started", "limit_stop", "turn_started"], "working"],
    [["session_started", "turn_started", "limit_stop", "turn_ended"], "walled"],
    [["session_started", "turn_started", "session_ended"], "dead"],
    [["turn_ended"], "idle"]
  ]
  for (const [kinds, expected] of cases) {
    it(`${kinds.join(" > ")} is ${expected}`, () => assert.strictEqual(deriveState(kinds), expected))
  }
})

layer(PgTest)("events", (it) => {
  const services = fleetWith(Runner.layerTest)

  it.effect("a duplicate event key changes nothing", () =>
    Effect.gen(function*() {
      yield* resetDb
      const events = yield* Events
      const first = yield* events.ingest(event("k1", "session_started", 0))
      assert.isFalse(first.duplicate)
      yield* events.ingest(event("k2", "turn_started", 1))
      const before = yield* events.session("s1")

      // Same key, different kind and time: stored nothing, answered duplicate.
      const again = yield* events.ingest(event("k2", "session_ended", 9))
      assert.isTrue(again.duplicate)
      const after = yield* events.session("s1")
      assert.deepStrictEqual(after, before)
      assert.strictEqual(after.state, "working")
    }).pipe(Effect.provide(services)))

  it.effect("derives each state from the stored events", () =>
    Effect.gen(function*() {
      yield* resetDb
      const events = yield* Events
      const state = (id: string) => events.session(id).pipe(Effect.map((session) => session.state))

      yield* events.ingest(event("a1", "session_started", 0, "a"))
      assert.strictEqual(yield* state("a"), "starting")
      yield* events.ingest(event("a2", "turn_started", 1, "a"))
      assert.strictEqual(yield* state("a"), "working")
      yield* events.ingest(event("a3", "turn_ended", 2, "a"))
      assert.strictEqual(yield* state("a"), "idle")
      yield* events.ingest(event("a4", "limit_stop", 3, "a"))
      assert.strictEqual(yield* state("a"), "walled")
      yield* events.ingest(event("a5", "turn_started", 4, "a"))
      assert.strictEqual(yield* state("a"), "working")
      yield* events.ingest(event("a6", "session_ended", 5, "a"))
      assert.strictEqual(yield* state("a"), "dead")

      const last = yield* events.session("a")
      assert.strictEqual(DateTime.toEpochMillis(last.lastEventAt), DateTime.toEpochMillis(at(5)))
    }).pipe(Effect.provide(services)))

  it.effect("a late-delivered event changes the answer", () =>
    Effect.gen(function*() {
      yield* resetDb
      const events = yield* Events
      yield* events.ingest(event("b1", "session_started", 0, "b"))
      yield* events.ingest(event("b2", "turn_started", 10, "b"))
      yield* events.ingest(event("b3", "turn_ended", 20, "b"))
      assert.strictEqual((yield* events.session("b")).state, "idle")

      // A spool replay delivers a limit_stop from minute 15 after the turn already ended: ordered by `at`
      // it sits inside the turn, with no turn_started after it.
      yield* events.ingest(event("b4", "limit_stop", 15, "b"))
      const walled = yield* events.session("b")
      assert.strictEqual(walled.state, "walled")
      // Arrival order did not decide it, and the newest `at` is still the turn_ended.
      assert.strictEqual(DateTime.toEpochMillis(walled.lastEventAt), DateTime.toEpochMillis(at(20)))

      // A late turn_started (minute 16) after the limit_stop clears the wall again.
      yield* events.ingest(event("b5", "turn_started", 16, "b"))
      assert.strictEqual((yield* events.session("b")).state, "idle")
    }).pipe(Effect.provide(services)))

  it.effect("equal timestamps fall back to insertion order", () =>
    Effect.gen(function*() {
      yield* resetDb
      const events = yield* Events
      yield* events.ingest(event("c1", "turn_started", 5, "c"))
      yield* events.ingest(event("c2", "turn_ended", 5, "c"))
      assert.strictEqual((yield* events.session("c")).state, "idle")
    }).pipe(Effect.provide(services)))

  it.effect("an unknown session is not found", () =>
    Effect.gen(function*() {
      yield* resetDb
      const events = yield* Events
      const error = yield* events.session("nope").pipe(Effect.flip)
      assert.strictEqual(error._tag, "SessionNotFound")
    }).pipe(Effect.provide(services)))
})
