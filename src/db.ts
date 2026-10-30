import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/** Applies every `migrations/*.sql` not yet recorded, in filename order, one transaction each. */
export async function migrate(sql: SQL, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    const [done] = await sql`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
    if (done) continue;
    const text = await Bun.file(join(dir, name)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    applied.push(name);
  }
  return applied;
}
