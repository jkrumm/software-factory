import { Config, Context, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface StartRequest {
  readonly key: string
  readonly repo: string
  readonly prompt: string
}

/** The command failed in a way another attempt may fix; the adapter's retries ran out. */
export class StartTransient extends Schema.TaggedError<StartTransient>()("StartTransient", {
  exitCode: Schema.Int,
  stderr: Schema.String
}) {}

/** The command can never succeed for this request: no retry. */
export class StartPermanent extends Schema.TaggedError<StartPermanent>()("StartPermanent", {
  reason: Schema.String
}) {}

/** Starts the session for a spawn. The spawn key is the pane name, so a replay starts nothing twice. */
export class Runner extends Context.Service<Runner, {
  start(request: StartRequest): Effect.Effect<{ readonly session: string }, StartTransient | StartPermanent>
}>()("factory/fleet/Runner") {
  static readonly layerTest = Layer.succeed(Runner, Runner.of({ start: ({ key }) => Effect.succeed({ session: key }) }))

  /** The herdr adapter: runs `$HERDR_BIN tab create --name <key> --cwd <repo>`. */
  static readonly layer = Layer.effect(Runner, Effect.gen(function*() {
    const bin = yield* Config.String("HERDR_BIN")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const exec = Effect.fn("Herdr.exec")(
      function*({ key, repo }: StartRequest) {
        const handle = yield* spawner.spawn(ChildProcess.make(bin, ["tab", "create", "--name", key, "--cwd", repo]))
        const [stdout, stderr, exitCode] = yield* Effect.all([
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ], { concurrency: "unbounded" })
        return { stdout, stderr, exitCode: Number(exitCode) }
      },
      Effect.scoped,
      Effect.mapError((cause) => new StartPermanent({ reason: `cannot run ${bin}: ${cause.message}` }))
    )

    const decodePane = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ pane: Schema.String })))

    const start = Effect.fn("Herdr.start")(
      function*(request: StartRequest) {
        const { stdout, stderr, exitCode } = yield* exec(request)
        const pane = decodePane(stdout)
        // Exit 3 is "name exists": an earlier call already made this pane, which is what we wanted.
        if (exitCode === 3) return { session: pane._tag === "Some" ? pane.value.pane : request.key }
        if (exitCode === 2) return yield* new StartPermanent({ reason: stderr.trim() || "herdr rejected the request" })
        if (exitCode !== 0) return yield* new StartTransient({ exitCode, stderr })
        if (pane._tag === "None") return yield* new StartPermanent({ reason: "herdr printed no pane" })
        return { session: pane.value.pane }
      },
      Effect.retry({ schedule: retrySchedule, while: (error) => error._tag === "StartTransient" })
    )

    return Runner.of({ start })
  }))
}

/** Capped exponential backoff with jitter: at most 5 retries. */
export const retrySchedule = Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 5 })
)
