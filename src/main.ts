import { BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { App } from "./App.ts"

BunRuntime.runMain(Layer.launch(App))
