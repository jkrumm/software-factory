---
name: effect
description: Write Effect 4 TypeScript in this repo. Use whenever code imports `effect` or `@effect/*`, or a brief says to build in Effect. Holds the pinned versions, the v3-to-v4 renames, the patterns that compile on the pinned version, and the determinism rule.
---

# Effect 4 in software-factory

**Your memory of Effect is v3 and it is wrong.** v4 postdates your training. Code that looks right often does not
exist. Before you use any API you have not already seen in this repo, look it up in `node_modules`:

1. `node_modules/effect/AGENTS.md`: the maintainers' guide. Read it once per session.
2. `node_modules/effect/ai-docs/src/<topic>/`: executable examples, by topic (`01_effect/`, `06_schedule/`,
   `09_testing/`, `40_sql/`, `51_http-server/`, `70_cli/`).
3. `node_modules/effect/src/<Module>.ts`: the truth. `grep -n '^export const name' node_modules/effect/src/Effect.ts`.

`LLMS.md` is not in the package. Do not trust web docs or mirrors: several still show `effect/unstable/*` paths.
Do not fetch a docs MCP; the source in `node_modules` matches the pin and they do not.

## Pins

Exact versions, all `effect`-family packages on one version. Never a range.

```json
{
  "dependencies": { "effect": "4.0.6", "@effect/sql-pg": "4.0.6", "@effect/platform-bun": "4.0.6" },
  "devDependencies": { "@effect/vitest": "4.0.6", "vitest": "5.0.5", "typescript": "7.0.2", "@effect/tsgo": "0.59.0" }
}
```

4.0.6 is the newest release that clears the machine's 3-day release-age cooldown (`~/.bunfig.toml`) as of
2026-10-30. Never add an exclude or lower that setting to get a newer version.

`tsc` is the feedback loop. `@effect/tsgo` patches the TypeScript 7 `tsc` so Effect's diagnostics fail the build
(a floating effect, a wrong layer, a removed API). Install with `"prepare": "effect-tsgo patch"`, then:

```json
{ "compilerOptions": { "plugins": [{ "name": "@effect/language-service", "diagnosticSeverity": {
  "unstableApiUsage": "off", "schemaClassMissingBrand": "off" } }] } }
```

`unstableApiUsage` is off because `effect/sql`, `@effect/sql-pg` and `@effect/platform-bun` are marked unstable and
this repo uses them on purpose, pinned. Run `tsc` after every file. Never silence a diagnostic with a cast or `any`.

## v3 → v4

| v3 in your memory | v4 |
|-|-|
| `Context.Tag`, `Context.GenericTag`, `Effect.Service` | `Context.Service<Self, Shape>()("id")` |
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.fork` | `Effect.forkChild` |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Effect.either` | `Effect.result` |
| `Effect.zipRight` | `Effect.andThen` |
| `Layer.scoped` | `Layer.effect` (it takes scoped effects) |
| `Schema.decodeUnknown` | `Schema.decodeUnknownEffect` |
| `Schema.Literal("a", "b")` | `Schema.Literals(["a", "b"])` |
| `Schema.Union(A, B)` | `Schema.Union([A, B])` |
| `Schema.parseJson` | `Schema.fromJsonString`, `Schema.UnknownFromJsonString` |
| `Schema.transformOrFail` | `Schema.transformEffect` |
| `FiberRef` | `Context.Reference` |
| `Runtime<R>` | removed; `ManagedRuntime` at the edge |
| `Config.redacted("X")` | `Config.Redacted("X")` |
| `@effect/platform`, `@effect/sql`, `@effect/rpc`, `@effect/cluster` | inside `effect`: `effect/http`, `effect/sql`, `effect/process`, `effect/cli` |
| `effect/unstable/*` | path without `unstable` |
| `TestClock` from `effect` | `import { TestClock } from "effect/testing"` |

This list is not complete. Anything not here: check `src/`.

## House rules (from `AGENTS.md`, plus this repo's)

- `Effect.gen` inline; `Effect.fn("Service.method")` for reusable functions, `Effect.fnUntraced` for hot paths.
- Never a function whose body only returns `Effect.gen`.
- Never `.pipe` an `Effect.fn`: pass combinators as extra arguments.
- Fail with `return yield* new SomeError({...})`, so TypeScript sees the function end.
- Errors are `Schema.TaggedError`. Handle them with `catchTag`/`catchTags`; let a defect stay a defect.
- All validation through `Schema`. No hand-written predicates; `Predicate` has the helpers.
- Services are classes with a static `layer`, and a static `layerTest` where a test needs one.
- `DateTime` and `Clock`, never `Date` or `Date.now`. `TestClock` only moves what goes through `Clock`.
- No `Effect.runPromise` inside an Effect. The only `run*` is at the process edge.

## Patterns that compile on the pin

```ts
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { Clock, Config, Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"

export class SpawnFailed extends Schema.TaggedError<SpawnFailed>()("SpawnFailed", {
  pane: Schema.String,
  cause: Schema.Defect()
}) {}

export class Runner extends Context.Service<Runner, {
  start(pane: string): Effect.Effect<void, SpawnFailed>
}>()("factory/fleet/Runner") {
  static readonly layerTest = Layer.succeed(Runner, Runner.of({ start: () => Effect.void }))
}

// Capped exponential backoff with jitter: at most 5 retries.
const retry = Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 5 })
)

export class Sessions extends Context.Service<Sessions, {
  record(session: string): Effect.Effect<void>
}>()("factory/fleet/Sessions") {
  static readonly layer = Layer.effect(Sessions, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const runner = yield* Runner
    const record = Effect.fn("Sessions.record")(
      function*(session: string) {
        const at = yield* Clock.currentTimeMillis
        yield* sql`insert into session_events ${sql.insert({ session, at })} on conflict do nothing`
        yield* runner.start(session).pipe(Effect.retry(retry))
      },
      Effect.catchTag("SpawnFailed", (e) => Effect.logError(e.pane)),
      Effect.orDie
    )
    return Sessions.of({ record })
  }))
}

const Pg = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })
const Migrations = PgMigrator.layer({ loader: PgMigrator.fromFileSystem("./migrations") }).pipe(
  Layer.provide(BunServices.layer)
)

// A background loop is a layer; Layer.launch keeps the process alive.
const Tick = Layer.effectDiscard(Effect.gen(function*() {
  const sessions = yield* Sessions
  yield* sessions.record("a").pipe(Effect.repeat(Schedule.spaced(Duration.seconds(5))), Effect.forkScoped)
}))

const App = Tick.pipe(
  Layer.provide(Sessions.layer),
  Layer.provide(Runner.layerTest),
  Layer.provide(Migrations),
  Layer.provide(Pg)
)

BunRuntime.runMain(Layer.launch(App))
```

- **Migrations** are files in the loader's directory named `0001_name.ts`, each `export default` an Effect.
  `fromFileSystem` needs an absolute path once the process cwd is not the repo root.
- **Queries:** `` sql`...` `` returns rows; `` sql<{ n: number }>`...` `` types them; `sql.insert({...})` and
  `sql.withTransaction(effect)` are on the client. A `SqlError` is in the error channel: handle or `orDie` it.
- **A private Postgres for tests:** `PgClient.layer({ host: "<socket dir>", port, username, database })`.

## Testing

`bun test` cannot run `@effect/vitest`. Use `vitest run`.

```ts
import { assert, describe, it, layer } from "@effect/vitest"
import { Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

describe("resume", () => {
  it.effect("waits for the reset", () => Effect.gen(function*() {
    let runs = 0
    const fiber = yield* Effect.forkChild(
      Effect.sync(() => { runs++ }).pipe(Effect.repeat(Schedule.spaced("1 minute")))
    )
    yield* TestClock.adjust("3 minutes")
    yield* Fiber.interrupt(fiber)
    assert.isAtLeast(runs, 3)
  }))
})

// Shared services across a block: layer(MyLayer)("name", (it) => { it.effect(...) })
```

`it.effect` runs on `TestClock`, so a sleep hangs until you `adjust`. `it.live` uses real time. Fake a port with a
`layerTest`, never by mocking a module.

## The determinism rule

Effect cannot type-check this. It is on you and on the review.

- **Every outside effect has a key built from facts:** session id, turn number, reset time. Never from a clock read
  or a random value, or a replay produces a new key and repeats the effect.
- **Record the key before the effect,** in Postgres, and do nothing if it is already there.
- **Handlers take their time from the event,** not from `Clock`. `Clock` is for deciding when to run a tick; the
  decision inside a tick reads stored facts.
- **Effect Cluster, Workflow, `Entity` and `SingleRunner` are not used here** (SF6). Postgres rows are the state.
