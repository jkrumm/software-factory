import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { deriveState, type EventKind } from "../src/sessions.ts";
import { startApp, type TestApp } from "./support/app.ts";
import { FakeClock } from "./support/clock.ts";
import { startTestDb, type TestDb } from "./support/pg.ts";

let db: TestDb;
let app: TestApp;

beforeAll(async () => {
  db = await startTestDb();
  app = startApp({ sql: db.sql, clock: new FakeClock() });
});
afterAll(async () => {
  await app.stop();
  await db.stop();
});
beforeEach(() => db.reset());

let counter = 0;
async function emit(session: string, kind: EventKind, at: string, key = `k${++counter}`): Promise<Response> {
  return app.send("POST", "/events", { key, session, kind, at });
}
const stateOf = async (session: string) => ((await (await app.get(`/sessions/${session}`)).json()) as { state: string }).state;

describe("duplicate event key", () => {
  test("changes nothing and answers 200 { duplicate: true }", async () => {
    const first = await emit("s1", "session_started", "2026-10-30T10:00:00Z", "same");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ duplicate: false });

    // Same key, different content: must be ignored entirely.
    const again = await emit("s1", "session_ended", "2026-10-30T11:00:00Z", "same");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });

    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM events`;
    expect(count).toBe(1);
    expect(await stateOf("s1")).toBe("starting");
  });
});

describe("derived session state", () => {
  test("starting: session_started and nothing after it", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    expect(await stateOf("s")).toBe("starting");
  });

  test("working: latest turn_started has no turn_ended after it", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "turn_started", "2026-10-30T10:01:00Z");
    expect(await stateOf("s")).toBe("working");
  });

  test("idle: the turn ended", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "turn_started", "2026-10-30T10:01:00Z");
    await emit("s", "turn_ended", "2026-10-30T10:02:00Z");
    expect(await stateOf("s")).toBe("idle");
  });

  test("walled: limit_stop with no later turn_started, and working again after one", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "turn_started", "2026-10-30T10:01:00Z");
    await emit("s", "limit_stop", "2026-10-30T10:02:00Z");
    expect(await stateOf("s")).toBe("walled");
    await emit("s", "turn_started", "2026-10-30T10:03:00Z");
    expect(await stateOf("s")).toBe("working");
  });

  test("dead: session_ended", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "session_ended", "2026-10-30T10:05:00Z");
    expect(await stateOf("s")).toBe("dead");
  });

  test("a late-delivered event changes the answer: order is by `at`, then insertion", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "turn_started", "2026-10-30T10:01:00Z");
    await emit("s", "limit_stop", "2026-10-30T10:03:00Z");
    expect(await stateOf("s")).toBe("walled");

    // The spool delivers a turn_started stamped after the limit_stop, but only now.
    await emit("s", "turn_started", "2026-10-30T10:04:00Z");
    expect(await stateOf("s")).toBe("working");

    // And a turn_ended stamped between them arrives last: it cannot undo the later turn_started.
    await emit("s", "turn_ended", "2026-10-30T10:02:00Z");
    expect(await stateOf("s")).toBe("working");
  });

  test("events with equal `at` fall back to insertion order", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "turn_started", "2026-10-30T10:01:00Z");
    await emit("s", "turn_ended", "2026-10-30T10:01:00Z");
    expect(await stateOf("s")).toBe("idle");
  });

  test("lastEventAt is the latest event by time; unknown session is 404", async () => {
    await emit("s", "session_started", "2026-10-30T10:00:00Z");
    await emit("s", "turn_started", "2026-10-30T10:09:00Z");
    await emit("s", "turn_ended", "2026-10-30T10:05:00Z");
    const view = (await (await app.get("/sessions/s")).json()) as { id: string; lastEventAt: string };
    expect(view).toMatchObject({ id: "s", lastEventAt: "2026-10-30T10:09:00.000Z" });
    expect((await app.get("/sessions/nope")).status).toBe(404);
  });

  test("deriveState is empty for no events", () => {
    expect(deriveState([])).toBeUndefined();
  });
});

describe("POST /events validation", () => {
  test.each([
    ["unknown kind", { key: "a", session: "s", kind: "boom", at: "2026-10-30T10:00:00Z" }],
    ["missing key", { session: "s", kind: "turn_ended", at: "2026-10-30T10:00:00Z" }],
    ["bad timestamp", { key: "a", session: "s", kind: "turn_ended", at: "yesterday" }],
    ["empty session", { key: "a", session: "", kind: "turn_ended", at: "2026-10-30T10:00:00Z" }],
  ])("%s is a 400 and stores nothing", async (_name, body) => {
    expect((await app.send("POST", "/events", body)).status).toBe(400);
    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM events`;
    expect(count).toBe(0);
  });

  test("a body that is not JSON is a 400", async () => {
    expect((await app.raw("/events", "{")).status).toBe(400);
  });

  test("an optional payload is accepted", async () => {
    const res = await app.send("POST", "/events", {
      key: "p",
      session: "s",
      kind: "limit_stop",
      at: "2026-10-30T10:00:00Z",
      payload: { resetsAt: "later" },
    });
    expect(res.status).toBe(201);
  });
});
