import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Runner } from "../src/Runner.ts"
import { driveClock, FakeHerdr, HerdrRunner } from "./support.ts"

const request = { key: "spawn-1", repo: "/tmp/repo", prompt: "do the thing" }

layer(HerdrRunner)("herdr adapter", (it) => {
  it.effect("retries a transient failure", () =>
    Effect.gen(function*() {
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      yield* herdr.failNext(2)
      const runner = yield* Runner

      const started = yield* driveClock(runner.start(request))

      assert.deepStrictEqual(started, { session: "pane-spawn-1" })
      assert.deepStrictEqual(yield* herdr.calls, ["spawn-1", "spawn-1", "spawn-1"])
    }))

  it.effect("gives up after 5 retries", () =>
    Effect.gen(function*() {
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      yield* herdr.failNext(100)
      const runner = yield* Runner

      const error = yield* driveClock(runner.start(request).pipe(Effect.flip))

      assert.strictEqual(error._tag, "StartTransient")
      assert.strictEqual((yield* herdr.calls).length, 6)
    }))

  it.effect("stops on exit 2 without retrying", () =>
    Effect.gen(function*() {
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      yield* herdr.failPermanently
      const runner = yield* Runner

      const error = yield* runner.start(request).pipe(Effect.flip)

      assert.strictEqual(error._tag, "StartPermanent")
      assert.deepStrictEqual(yield* herdr.calls, ["spawn-1"])
    }))

  it.effect("treats exit 3 (name exists) as success", () =>
    Effect.gen(function*() {
      const herdr = yield* FakeHerdr
      yield* herdr.reset
      const runner = yield* Runner

      const first = yield* runner.start(request)
      const again = yield* runner.start(request)

      assert.deepStrictEqual(again, first)
      assert.deepStrictEqual(yield* herdr.calls, ["spawn-1", "spawn-1"])
      assert.deepStrictEqual(yield* herdr.panes, ["spawn-1"])
    }))
})
