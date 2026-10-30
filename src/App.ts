import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { Capacity } from "./Capacity.ts"
import { Db } from "./Db.ts"
import { Events } from "./Events.ts"
import { Routes } from "./Http.ts"
import { Runner } from "./Runner.ts"
import { Spawns } from "./Spawns.ts"
import { Ticker } from "./Ticker.ts"

/** The services over Postgres and a `Runner`; the HTTP edge and the tick loop share one instance. */
export const Fleet = Layer.mergeAll(
  Events.layer,
  Capacity.layer,
  Spawns.layer.pipe(Layer.provide(Capacity.layer))
)

/** Loopback only; the port comes from `PORT`. */
const Server = BunHttpServer.layerConfig({ hostname: Config.succeed("127.0.0.1"), port: Config.Int("PORT") })

export const Api = HttpRouter.serve(Routes).pipe(Layer.provide(Server))

export const App = Layer.mergeAll(Api, Ticker).pipe(
  Layer.provide(Fleet),
  Layer.provide(Runner.layer),
  Layer.provide(BunServices.layer),
  Layer.provide(Db)
)
