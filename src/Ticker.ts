import { Duration, Effect, Layer, Schedule } from "effect"
import { Spawns } from "./Spawns.ts"

/** Ticks once on start, then every 5 seconds, until the scope closes. */
export const Ticker = Layer.effectDiscard(Effect.gen(function*() {
  const spawns = yield* Spawns
  yield* spawns.tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.seconds(5))),
    Effect.forkScoped
  )
}))
