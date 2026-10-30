import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { backoffMs, DEFAULT_RETRY, HerdrRunner, RunnerError } from "../src/runner.ts";
import { FakeClock } from "./support/clock.ts";
import { createFakeHerdr, type FakeHerdr } from "./support/herdr.ts";

let herdr: FakeHerdr;
let clock: FakeClock;
let runner: HerdrRunner;
const input = { key: "spawn-1", repo: "/work/repo", prompt: "do it" };

beforeAll(async () => {
  herdr = await createFakeHerdr();
});
afterAll(() => herdr.cleanup());
beforeEach(async () => {
  clock = new FakeClock();
  runner = new HerdrRunner({ bin: herdr.bin, clock });
  await herdr.reset();
});

const failure = async (): Promise<RunnerError> => {
  const error = await runner.start(input).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RunnerError);
  return error as RunnerError;
};

describe("herdr adapter", () => {
  test("success on the first call: the pane is the session", async () => {
    expect(await runner.start(input)).toEqual({ session: "pane-spawn-1", attempts: 1 });
    expect(clock.sleeps).toEqual([]);
  });

  test("retried on a transient failure, with capped exponential backoff", async () => {
    await herdr.plan(1, 1, 7);
    expect(await runner.start({ ...input, key: "transient" })).toEqual({ session: "pane-transient", attempts: 4 });
    expect(await herdr.calls()).toEqual(Array(4).fill("transient"));
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  test("gives up after 5 retries, never sleeping past the cap", async () => {
    await herdr.plan(...Array<number>(6).fill(1));
    const error = await failure();
    expect(error).toMatchObject({ permanent: false, attempts: 6 });
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(backoffMs(DEFAULT_RETRY, 9)).toBe(DEFAULT_RETRY.capMs);
  });

  test("exit 2 is permanent: no retry, no sleep", async () => {
    await herdr.plan(2);
    const before = (await herdr.calls()).length;
    const error = await failure();
    expect(error).toMatchObject({ permanent: true, attempts: 1 });
    expect((await herdr.calls()).length - before).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("exit 3 (name exists) is success and is not retried", async () => {
    await runner.start({ ...input, key: "twice" });
    const before = (await herdr.calls()).length;
    expect(await runner.start({ ...input, key: "twice" })).toEqual({ session: "twice", attempts: 1 });
    expect((await herdr.calls()).length - before).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("a binary that cannot run is permanent", async () => {
    const broken = new HerdrRunner({ bin: "/nonexistent/herdr", clock });
    expect(await broken.start(input).catch((e: unknown) => e)).toMatchObject({ permanent: true });
  });
});
