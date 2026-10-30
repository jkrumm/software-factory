import { assert, layer } from "@effect/vitest"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Capacity } from "../src/Capacity.ts"
import { Runner } from "../src/Runner.ts"
import type { StartRequest } from "../src/Runner.ts"
import { Spawns } from "../src/Spawns.ts"
import { fleet, fleetWith, FakeHerdr, HerdrRunner, PgTest, resetDb } from "./support.ts"

const input = { key: "spawn-1", repo: "/tmp/repo", prompt: "do the thing" }

const hoursFromNow = (hours: number) => DateTime.now.pipe(Effect.map(DateTime.add({ hours })))

/** A `Runner` that records its calls and never touches a process. */
const recordingRunner = (calls: Array<string>) =>
  Layer.succeed(
    Runner,
    Runner.of({
      start: ({ key }) =>
        Effect.sync(() => {
          calls.push(key)
          return { session: `pane-${key}` }
        })
    })
  )

layer(Layer.mergeAll(PgTest, HerdrRunner))("spawns", (it) => {

  it.effect("a spawn with capacity starts on the tick", () =>
    Effect.gen(function*() {
      yield* resetDb
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      yield* capacity.record("a", { weeklyUsed: 40, fiveHourUsed: 10, resetsAt: yield* hoursFromNow(3) })

      const { spawn, created } = yield* spawns.create(input)
      assert.isTrue(created)
      assert.strictEqual(spawn.status, "pending")
      assert.strictEqual(spawn.account, "a")
      assert.isNull(spawn.resumeAt)
      assert.deepStrictEqual(yield* herdr.calls, [])

      const report = yield* spawns.tick

      assert.deepStrictEqual(report.outcomes, [{ key: "spawn-1", outcome: "started" }])
      const after = yield* spawns.get("spawn-1")
      assert.strictEqual(after.status, "started")
      assert.strictEqual(after.session, "pane-spawn-1")
      assert.strictEqual(after.attempts, 1)
      assert.deepStrictEqual(yield* herdr.panes, ["spawn-1"])
    }).pipe(Effect.provide(fleet)))

  it.effect("a repeated spawn key returns the existing row", () =>
    Effect.gen(function*() {
      yield* resetDb
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      yield* capacity.record("a", { weeklyUsed: 40, fiveHourUsed: 10, resetsAt: yield* hoursFromNow(3) })
      yield* spawns.create(input)
      yield* capacity.record("a", { weeklyUsed: 99, fiveHourUsed: 10, resetsAt: yield* hoursFromNow(3) })

      const again = yield* spawns.create({ ...input, prompt: "something else" })

      assert.isFalse(again.created)
      assert.strictEqual(again.spawn.prompt, "do the thing")
      assert.strictEqual(again.spawn.account, "a")
    }).pipe(Effect.provide(fleet)))

  it.effect("the capacity rule: weekly under 95 and five-hour under 85, least weekly use first", () =>
    Effect.gen(function*() {
      yield* resetDb
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      const resetsAt = yield* hoursFromNow(3)
      yield* capacity.record("full-week", { weeklyUsed: 95, fiveHourUsed: 0, resetsAt })
      yield* capacity.record("full-window", { weeklyUsed: 0, fiveHourUsed: 85, resetsAt })
      yield* capacity.record("busy", { weeklyUsed: 60, fiveHourUsed: 20, resetsAt })
      yield* capacity.record("quiet", { weeklyUsed: 30, fiveHourUsed: 20, resetsAt })
      // The latest reading of an account is the one that counts.
      yield* capacity.record("full-week", { weeklyUsed: 10, fiveHourUsed: 0, resetsAt })
      yield* capacity.record("quiet", { weeklyUsed: 94, fiveHourUsed: 0, resetsAt })

      const { spawn } = yield* spawns.create(input)

      assert.strictEqual(spawn.account, "full-week")
    }).pipe(Effect.provide(fleet)))

  it.effect("without capacity a spawn waits with the earliest reset, then starts on a new reading", () =>
    Effect.gen(function*() {
      yield* resetDb
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      const later = yield* hoursFromNow(4)
      const sooner = yield* hoursFromNow(2)
      yield* capacity.record("a", { weeklyUsed: 97, fiveHourUsed: 10, resetsAt: later })
      yield* capacity.record("b", { weeklyUsed: 10, fiveHourUsed: 90, resetsAt: sooner })

      const { spawn } = yield* spawns.create(input)
      assert.strictEqual(spawn.status, "waiting")
      assert.isNull(spawn.account)
      assert.strictEqual(DateTime.toEpochMillis(spawn.resumeAt!), DateTime.toEpochMillis(sooner))

      assert.deepStrictEqual((yield* spawns.tick).outcomes, [{ key: "spawn-1", outcome: "waiting" }])
      assert.deepStrictEqual(yield* herdr.calls, [])

      yield* capacity.record("b", { weeklyUsed: 10, fiveHourUsed: 20, resetsAt: sooner })
      assert.deepStrictEqual((yield* spawns.tick).outcomes, [{ key: "spawn-1", outcome: "started" }])

      const after = yield* spawns.get("spawn-1")
      assert.strictEqual(after.status, "started")
      assert.strictEqual(after.account, "b")
    }).pipe(Effect.provide(fleet)))

  it.effect("without capacity a spawn starts at its resume_at", () =>
    Effect.gen(function*() {
      yield* resetDb
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      yield* capacity.record("a", { weeklyUsed: 99, fiveHourUsed: 10, resetsAt: yield* hoursFromNow(2) })
      yield* spawns.create(input)

      yield* TestClock.adjust("119 minutes")
      assert.deepStrictEqual((yield* spawns.tick).outcomes, [{ key: "spawn-1", outcome: "waiting" }])

      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual((yield* spawns.tick).outcomes, [{ key: "spawn-1", outcome: "started" }])
      const after = yield* spawns.get("spawn-1")
      assert.strictEqual(after.account, "a")
      assert.deepStrictEqual(yield* herdr.calls, ["spawn-1"])
    }).pipe(Effect.provide(fleet)))

  it.effect("a permanent runner failure fails the spawn", () =>
    Effect.gen(function*() {
      yield* resetDb
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      yield* herdr.failPermanently
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      yield* capacity.record("a", { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: yield* hoursFromNow(3) })
      yield* spawns.create(input)

      assert.deepStrictEqual((yield* spawns.tick).outcomes, [{ key: "spawn-1", outcome: "failed" }])
      assert.strictEqual((yield* spawns.get("spawn-1")).status, "failed")
      // Failed is final: the next tick leaves it alone.
      assert.deepStrictEqual((yield* spawns.tick).outcomes, [])
    }).pipe(Effect.provide(fleet)))

  it.effect("replay: a crash after the adapter call starts no second pane", () =>
    Effect.gen(function*() {
      yield* resetDb
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      const capacity = yield* Capacity
      const spawns = yield* Spawns
      yield* capacity.record("a", { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: yield* hoursFromNow(3) })
      yield* spawns.create(input)

      // The real adapter runs, then the process "dies" before the result is recorded.
      const real = yield* Runner
      const crashing = Layer.succeed(
        Runner,
        Runner.of({ start: (request: StartRequest) => real.start(request).pipe(Effect.andThen(Effect.die("crash"))) })
      )
      const crashed = yield* Spawns.use((s) => s.tick).pipe(Effect.provide(fleetWith(crashing)), Effect.exit)
      assert.isTrue(crashed._tag === "Failure")

      assert.deepStrictEqual(yield* herdr.panes, ["spawn-1"])
      const mid = yield* spawns.get("spawn-1")
      assert.strictEqual(mid.status, "pending")
      assert.strictEqual(mid.attempts, 0)

      const report = yield* spawns.tick

      assert.deepStrictEqual(report.outcomes, [{ key: "spawn-1", outcome: "started" }])
      assert.strictEqual((yield* spawns.get("spawn-1")).status, "started")
      // Called twice, but the key made the second call a no-op: one pane.
      assert.deepStrictEqual(yield* herdr.calls, ["spawn-1", "spawn-1"])
      assert.deepStrictEqual(yield* herdr.panes, ["spawn-1"])
    }).pipe(Effect.provide(fleet)))

  it.effect("two concurrent ticks start a due spawn once", () =>
    Effect.gen(function*() {
      yield* resetDb
      const calls: Array<string> = []
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const gated = Layer.succeed(
        Runner,
        Runner.of({
          start: ({ key }) =>
            Effect.gen(function*() {
              calls.push(key)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return { session: `pane-${key}` }
            })
        })
      )
      const run = Effect.gen(function*() {
        const capacity = yield* Capacity
        const spawns = yield* Spawns
        yield* capacity.record("a", { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: yield* hoursFromNow(3) })
        yield* spawns.create(input)

        // The first tick is inside the runner, holding the row lock; the second runs to the end meanwhile.
        const first = yield* Effect.forkChild(spawns.tick)
        yield* Deferred.await(entered)
        const second = yield* spawns.tick
        yield* Deferred.succeed(release, undefined)
        const firstReport = yield* Fiber.join(first)

        assert.deepStrictEqual(second.outcomes, [])
        assert.deepStrictEqual(firstReport.outcomes, [{ key: "spawn-1", outcome: "started" }])
        assert.deepStrictEqual(calls, ["spawn-1"])
        assert.strictEqual((yield* spawns.get("spawn-1")).attempts, 1)
      })
      yield* run.pipe(Effect.provide(fleetWith(gated)))
    }))

  it.effect("a runner double records nothing for a waiting spawn", () =>
    Effect.gen(function*() {
      yield* resetDb
      const calls: Array<string> = []
      yield* Effect.gen(function*() {
        const spawns = yield* Spawns
        yield* spawns.create(input)
        // No reading at all: nothing to pick and no reset to wait for.
        const { outcomes } = yield* spawns.tick
        assert.deepStrictEqual(outcomes, [{ key: "spawn-1", outcome: "waiting" }])
        assert.isNull((yield* spawns.get("spawn-1")).resumeAt)
      }).pipe(Effect.provide(fleetWith(recordingRunner(calls))))
      assert.deepStrictEqual(calls, [])
    }))
})
