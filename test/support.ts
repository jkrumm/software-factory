import { BunServices } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { ConfigProvider, Context, Deferred, Effect, Fiber, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Capacity } from "../src/Capacity.ts"
import { Migrations } from "../src/Db.ts"
import { Events } from "../src/Events.ts"
import { Routes } from "../src/Http.ts"
import { Runner } from "../src/Runner.ts"
import { Spawns } from "../src/Spawns.ts"

const freePort = Effect.promise(() =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
    })
  })
)

const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "factory-spike-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
)

const sh = Effect.fn("sh")(function*(command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make(command, args))
}, Effect.orDie)

/**
 * A private Postgres cluster in a temp dir: unix socket only, no fsync, stopped and removed with the scope.
 * Provides a migrated `PgClient` (and its `SqlClient`).
 */
export const PgTest = Layer.unwrap(Effect.gen(function*() {
  const dir = yield* tempDir
  const data = join(dir, "data")
  const port = yield* freePort
  yield* sh("initdb", ["-D", data, "-U", "factory", "--auth=trust", "--no-sync"])
  yield* Effect.acquireRelease(
    sh("pg_ctl", [
      "start",
      "-D",
      data,
      "-w",
      "-l",
      join(dir, "pg.log"),
      "-o",
      `-c listen_addresses= -c unix_socket_directories=${dir} -c fsync=off -c port=${port}`
    ]),
    () => sh("pg_ctl", ["stop", "-D", data, "-m", "immediate"]).pipe(Effect.ignore)
  )
  return PgClient.layer({ host: dir, port, username: "factory", database: "postgres" })
})).pipe(
  (pg) => Migrations.pipe(Layer.provideMerge(pg)),
  Layer.provide(BunServices.layer)
)

export const resetDb = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`truncate session_events, capacity_readings, spawns restart identity`
}).pipe(Effect.orDie)

const script = (state: string) =>
  `#!/bin/sh
# fake herdr: tab create --name <key> --cwd <repo>
state=${JSON.stringify(state)}
name="$4"
echo "$name" >> "$state/calls"
if [ -f "$state/permanent" ]; then echo "bad request" >&2; exit 2; fi
if [ -f "$state/fail" ]; then
  left=$(cat "$state/fail")
  if [ "$left" -gt 0 ]; then
    echo $((left - 1)) > "$state/fail"
    echo "herdr busy" >&2
    exit 1
  fi
fi
if [ -f "$state/panes/$name" ]; then echo "{\\"pane\\": \\"pane-$name\\"}"; exit 3; fi
touch "$state/panes/$name"
echo "{\\"pane\\": \\"pane-$name\\"}"
`

/** A fake `HERDR_BIN` that records its calls and the panes it created. */
export class FakeHerdr extends Context.Service<FakeHerdr, {
  readonly calls: Effect.Effect<ReadonlyArray<string>>
  readonly panes: Effect.Effect<ReadonlyArray<string>>
  failNext(times: number): Effect.Effect<void>
  readonly failPermanently: Effect.Effect<void>
  readonly reset: Effect.Effect<void>
}>()("test/FakeHerdr") {
  /** The service and the `HERDR_BIN` config pointing at it. */
  static readonly layer = Layer.unwrap(Effect.gen(function*() {
    const dir = yield* tempDir
    const bin = join(dir, "herdr")
    const read = (file: string) =>
      Effect.promise(() => readFile(join(dir, file), "utf8").catch(() => "")).pipe(
        Effect.map((text) => text.split("\n").filter((line) => line !== ""))
      )
    const reset = Effect.promise(async () => {
      await rm(join(dir, "panes"), { recursive: true, force: true })
      await Promise.all(["calls", "fail", "permanent"].map((file) => rm(join(dir, file), { force: true })))
      await mkdir(join(dir, "panes"), { recursive: true })
    })
    yield* reset
    yield* Effect.promise(async () => {
      await writeFile(bin, script(dir))
      await chmod(bin, 0o755)
    })
    const herdr = FakeHerdr.of({
      calls: read("calls"),
      panes: Effect.promise(async () => (await readdir(join(dir, "panes"))).sort()),
      failNext: (times) => Effect.promise(() => writeFile(join(dir, "fail"), `${times}\n`)),
      failPermanently: Effect.promise(() => writeFile(join(dir, "permanent"), "")),
      reset
    })
    return Layer.mergeAll(
      Layer.succeed(FakeHerdr, herdr),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_BIN: bin }))
    )
  })).pipe(Layer.provide(BunServices.layer))
}

/** The herdr adapter against the fake binary; the fake stays visible to the tests. */
export const HerdrRunner = Runner.layer.pipe(
  Layer.provideMerge(FakeHerdr.layer),
  Layer.provide(BunServices.layer)
)

/** The fleet services over the ambient Postgres and the ambient `Runner`. */
export const fleet = Layer.mergeAll(Events.layer, Spawns.layer.pipe(Layer.provideMerge(Capacity.layer)))

/**
 * The fleet services over the ambient Postgres, with the given `Runner`. `fresh`, because layers are memoized by
 * reference and an inner provide would otherwise reuse the services the outer one already built.
 */
export const fleetWith = <E, R>(runner: Layer.Layer<Runner, E, R>) => Layer.fresh(fleet.pipe(Layer.provide(runner)))

/**
 * Runs `self` on a fiber and moves the `TestClock` until it finishes: child processes and Postgres are real I/O,
 * the retry delays are not.
 */
export const driveClock = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const done = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(self.pipe(Effect.ensuring(Deferred.succeed(done, undefined))))
    while (!(yield* Deferred.isDone(done))) {
      yield* TestClock.adjust("10 seconds")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))
    }
    return yield* Fiber.join(fiber)
  })

/** The HTTP routes as a `fetch`, over the ambient Postgres and a no-op `Runner`. */
export const webApp = Effect.gen(function*() {
  const fleet = yield* Layer.build(fleetWith(Runner.layerTest))
  const { handler, dispose } = HttpRouter.toWebHandler(
    Routes.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true }
  )
  yield* Effect.addFinalizer(() => Effect.promise(dispose))
  return (path: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(`http://test${path}`, init), fleet))
})
