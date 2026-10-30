import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { HerdrRunner } from "../src/runner.ts";
import { tick } from "../src/tick.ts";
import { startApp, type TestApp } from "./support/app.ts";
import { FakeClock } from "./support/clock.ts";
import { createFakeHerdr, type FakeHerdr } from "./support/herdr.ts";
import { startTestDb, type TestDb } from "./support/pg.ts";

let db: TestDb;
let herdr: FakeHerdr;
let app: TestApp;
const clock = new FakeClock();

beforeAll(async () => {
  db = await startTestDb();
  herdr = await createFakeHerdr();
  app = startApp({ sql: db.sql, clock });
});
afterAll(async () => {
  await app.stop();
  await herdr.cleanup();
  await db.stop();
});
beforeEach(async () => {
  await db.reset();
  await herdr.reset();
});

const runTick = () => tick({ sql: db.sql, clock, runner: new HerdrRunner({ bin: herdr.bin, clock }) });
const inHours = (h: number) => new Date(clock.now().getTime() + h * 3_600_000).toISOString();
const reading = (account: string, weeklyUsed: number, fiveHourUsed: number, resetsAt: string) =>
  app.send("PUT", `/capacity/${account}`, { weeklyUsed, fiveHourUsed, resetsAt });
const spawn = (key: string) => app.send("POST", "/spawns", { key, repo: "/work/repo", prompt: "do it" });
const status = async (key: string) => (await app.get(`/spawns/${key}`)).json() as Promise<Record<string, unknown>>;

describe("a spawn with capacity", () => {
  test("is stored for an account and starts on the next tick", async () => {
    await reading("a", 10, 10, inHours(2));
    const res = await spawn("s1");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ key: "s1", status: "queued", account: "a", resumeAt: null, attempts: 0 });
    expect(await herdr.panes()).toEqual([]);

    expect(await runTick()).toMatchObject({ started: ["s1"], failed: [], errors: [] });
    expect(await status("s1")).toMatchObject({ status: "started", account: "a", attempts: 1, session: "pane-s1" });
    expect(await herdr.panes()).toEqual(["s1"]);

    // Nothing left to do.
    expect(await runTick()).toMatchObject({ started: [] });
    expect(await herdr.calls()).toEqual(["s1"]);
  });

  test("takes the least-used eligible account", async () => {
    await reading("busy", 80, 10, inHours(2));
    await reading("quiet", 20, 10, inHours(2));
    expect(await (await spawn("s1")).json()).toMatchObject({ account: "quiet" });
  });

  test("a repeated key returns the existing row", async () => {
    await reading("a", 10, 10, inHours(2));
    await spawn("s1");
    await runTick();
    const again = await spawn("s1");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ key: "s1", status: "started", session: "pane-s1" });
  });
});

describe("eligibility", () => {
  test.each([
    ["weekly 94", 94, 0, true],
    ["weekly 95", 95, 0, false],
    ["five-hour 84", 0, 84, true],
    ["five-hour 85", 0, 85, false],
  ])("%s", async (_name, weekly, fiveHour, eligible) => {
    await reading("a", weekly, fiveHour, inHours(1));
    expect(await (await spawn("s")).json()).toMatchObject({ status: eligible ? "queued" : "waiting" });
  });

  test("only the latest reading of an account counts", async () => {
    await reading("a", 99, 0, inHours(1));
    await reading("a", 10, 0, inHours(1));
    expect(await (await spawn("s")).json()).toMatchObject({ status: "queued", account: "a" });
  });
});

describe("a spawn without capacity", () => {
  test("waits with resume_at at the earliest reset, then starts after a new reading", async () => {
    await reading("a", 96, 0, inHours(5));
    await reading("b", 10, 90, inHours(2));
    const res = await spawn("s1");
    expect(await res.json()).toMatchObject({ status: "waiting", account: null, resumeAt: inHours(2) });

    expect(await runTick()).toMatchObject({ started: [], skipped: 1 });
    expect(await herdr.calls()).toEqual([]);

    await reading("b", 10, 20, inHours(2));
    expect(await runTick()).toMatchObject({ started: ["s1"] });
    expect(await status("s1")).toMatchObject({ status: "started", account: "b", attempts: 1 });
  });

  test("starts once resume_at has passed, by moving the clock rather than waiting", async () => {
    await reading("a", 96, 0, inHours(5));
    await reading("b", 10, 90, inHours(2));
    await spawn("s1");

    clock.advance(2 * 3_600_000 - 1);
    expect(await runTick()).toMatchObject({ started: [] });

    clock.advance(1);
    expect(await runTick()).toMatchObject({ started: ["s1"] });
    expect(await status("s1")).toMatchObject({ status: "started", account: "b" });
  });

  test("with no reading at all it waits with no resume_at until one arrives", async () => {
    expect(await (await spawn("s1")).json()).toMatchObject({ status: "waiting", account: null, resumeAt: null });
    expect(await runTick()).toMatchObject({ started: [] });
    await reading("a", 1, 1, inHours(1));
    expect(await runTick()).toMatchObject({ started: ["s1"] });
  });
});

describe("validation", () => {
  test("bad spawn and capacity bodies are 400", async () => {
    expect((await app.send("POST", "/spawns", { key: "x" })).status).toBe(400);
    expect((await app.send("PUT", "/capacity/a", { weeklyUsed: "lots" })).status).toBe(400);
    expect((await app.get("/spawns/unknown")).status).toBe(404);
  });
});
