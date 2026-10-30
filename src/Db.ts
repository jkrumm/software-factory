import { BunServices } from "@effect/platform-bun"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { fileURLToPath } from "node:url"

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url))

/** Applies `migrations/` on build; anything built on top sees a migrated database. */
export const Migrations = PgMigrator.layer({ loader: PgMigrator.fromFileSystem(migrationsDir) }).pipe(
  Layer.provide(BunServices.layer)
)

export const PgFromEnv = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })

export const Db = Migrations.pipe(Layer.provideMerge(PgFromEnv))
