import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { recordReading } from "../src/capacity.ts";
import { createSpawn } from "../src/spawns.ts";
import { HerdrRunner, type Runner, type StartInput } from "../src/runner.ts";
import { tick } from "../src/tick.ts";
import { FakeClock } from "./support/clock.ts";
import { createFakeHerdr, type FakeHerdr } from "./support/herdr.ts";
import { startTestDb, type TestDb } from "./support/pg.ts";

let db: TestDb;
let herdr: FakeHerdr;
let clock: FakeClock;

beforeAll(async () => {
  db = await startTestDb();
  herdr = await createFakeHerdr();
});
afterAll(async () => {
  await herdr.cleanup();
  await db.stop();
});
beforeEach(async () => {
  await db.reset();
  await herdr.reset();
  clock = new FakeClock();
  await recordReading(db.sql, "a", { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: new Date(clock.now().getTime() + 3_600_000) });
});

const addSpawn = (key: string) => createSpawn(db.sql, { key, repo: "/work/repo", prompt: "do it" }, clock.now());
const spawnRow = async (key: string) => {
  const [row] = await db.sql`SELECT status, attempts, session, error FROM spawns WHERE key = ${key}`;
  return row as { status: string; attempts: number; session: string | null; error: string | null };
};

describe("tick and failures", () => {
  test("a permanent refusal marks the spawn failed and does not stop the others", async () => {
    await addSpawn("bad");
    await addSpawn("good");
    await herdr.plan(2);
    const runner = new HerdrRunner({ bin: herdr.bin, clock });

    expect(await tick({ sql: db.sql, runner, clock })).toMatchObject({ failed: ["bad"], started: ["good"], errors: [] });
    expect(await spawnRow("bad")).toMatchObject({ status: "failed", attempts: 1 });
    expect(await spawnRow("good")).toMatchObject({ status: "started", attempts: 1 });
    // A failed spawn is final: later ticks leave it alone.
    expect(await tick({ sql: db.sql, runner, clock })).toMatchObject({ failed: [], started: [], skipped: 0 });
  });

  test("retries exhausted marks the spawn failed with the attempts used", async () => {
    await addSpawn("flaky");
    await herdr.plan(...Array<number>(6).fill(1));
    const runner = new HerdrRunner({ bin: herdr.bin, clock });

    expect(await tick({ sql: db.sql, runner, clock })).toMatchObject({ failed: ["flaky"] });
    expect(await spawnRow("flaky")).toMatchObject({ status: "failed", attempts: 6 });
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
  });
});

describe("replay", () => {
  test("a crash after the adapter call and before the result is recorded starts no second pane", async () => {
    await addSpawn("s1");
    const herdrRunner = new HerdrRunner({ bin: herdr.bin, clock });
    const crashing: Runner = {
      async start(input: StartInput) {
        await herdrRunner.start(input);
        throw new Error("crash before the result is recorded");
      },
    };

    const crashed = await tick({ sql: db.sql, runner: crashing, clock });
    expect(crashed.errors).toHaveLength(1);
    expect(crashed.started).toEqual([]);
    // The pane exists, the database never heard of it.
    expect(await herdr.panes()).toEqual(["s1"]);
    expect(await spawnRow("s1")).toMatchObject({ status: "queued", attempts: 0, session: null });

    const replay = await tick({ sql: db.sql, runner: herdrRunner, clock });
    expect(replay).toMatchObject({ started: ["s1"], errors: [] });
    expect(await herdr.panes()).toEqual(["s1"]);
    expect(await herdr.calls()).toEqual(["s1", "s1"]);
    // The second call found the name (exit 3) and was accepted as success on the first attempt.
    expect(await spawnRow("s1")).toMatchObject({ status: "started", attempts: 1, session: "s1" });
  });
});

describe("concurrent ticks", () => {
  test("two ticks at once start a due spawn exactly once", async () => {
    await addSpawn("s1");

    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inRunner = new Promise<void>((resolve) => (entered = resolve));
    const runner: Runner = {
      async start(input) {
        starts.push(input.key);
        entered();
        await gate;
        return { session: `pane-${input.key}`, attempts: 1 };
      },
    };

    // Tick A claims the row and is held inside the runner, so tick B runs while the row is locked.
    const a = tick({ sql: db.sql, runner, clock });
    await inRunner;
    const b = await tick({ sql: db.sql, runner, clock });
    expect(b).toMatchObject({ started: [], skipped: 1, errors: [] });

    release();
    expect(await a).toMatchObject({ started: ["s1"], errors: [] });
    expect(starts).toEqual(["s1"]);
    expect(await spawnRow("s1")).toMatchObject({ status: "started", attempts: 1, session: "pane-s1" });
  });

  test("two ticks racing over several spawns start each exactly once", async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `s${i}`);
    for (const key of keys) await addSpawn(key);
    const runner = new HerdrRunner({ bin: herdr.bin, clock });

    const [a, b] = await Promise.all([tick({ sql: db.sql, runner, clock }), tick({ sql: db.sql, runner, clock })]);
    expect([...a.started, ...b.started].sort()).toEqual(keys);
    expect((await herdr.calls()).sort()).toEqual(keys);
    expect((await herdr.panes()).sort()).toEqual(keys);
  });
});
