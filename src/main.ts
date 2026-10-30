import { SQL } from "bun";
import { systemClock } from "./clock.ts";
import { migrate } from "./db.ts";
import { serve } from "./http.ts";
import { HerdrRunner } from "./runner.ts";
import { startTicker } from "./tick.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sql = new SQL(requireEnv("DATABASE_URL"));
await migrate(sql);

const clock = systemClock;
const runner = new HerdrRunner({ bin: requireEnv("HERDR_BIN"), clock });
const ticker = startTicker({ sql, runner, clock });
const server = serve({ sql, clock, port: Number(requireEnv("PORT")) });
console.log(`listening on ${server.url}`);

process.on("SIGTERM", async () => {
  ticker.stop();
  await server.stop();
  await sql.close();
  process.exit(0);
});
