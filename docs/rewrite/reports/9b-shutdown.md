# Package 9b: a SIGTERM always ends the server, report

Branch `rw/9b-shutdown`, one fix commit (`6a3a46f`) plus this report. Fixes window 1, finding 1 (`docs/rewrite/learnings.md`).

## Cause

Two faults, both in `apps/server/src/main.ts`:

1. `await app.stop()` was called without `true`. Elysia 1.4.30 (`dist/adapter/bun/index.mjs`, `stop(app, closeActiveConnections)`) passes the flag straight to Bun's `server.stop(closeActiveConnections)`. Bun 1.4.2 (`bun-types/serve.d.ts`): by default in-flight requests are not cancelled, idle keep-alive connections close at once, and *the promise resolves once every connection is closed*. An SSE stream (`/v1/stream`, `factory follow`) never completes on its own, so the promise never resolved and every later step (loops, lock, pool) never ran.
2. The new `main.ts` had **no deadline at all**. The string `shutdown took too long (still in: …)` exists only in `legacy/server/src/main.ts`; the new stop was an unbounded chain of awaits.

The scenario fails on the unfixed `main.ts` (process still alive 15 s after "SIGTERM: stopping") and passes on the fix.

## What changed

- **`apps/server/src/shutdown.ts`** (new): `createShutdown({ steps, deadlineMs })`. Steps run in order; a step that throws is logged and the rest still run (the lock must be let go even when a loop's stop failed); a deadline timer (referenced, so a stop stuck on something with no open handle still fires) logs `shutdown took too long (still in: <step>), exiting` and exits 1. Exit 0 only if every step finished without error. A second signal does nothing.
- **`apps/server/src/main.ts`**: the stop is that list: `draining` (abort the watch's signal), `server.stop` (`app.stop(true)`: closes the stream and kept-alive sockets), `loops.stop` (10 s grace, as before), `hook socket.stop`, `intake.stop`, `lock.release`, `database.close`.
- **`apps/server/src/settings.ts`**, **`scripts/env-file.sh`**: `FACTORY_SHUTDOWN_DEADLINE_MS` (default 30 s, min 1), on the settings-file allow-list (a unit test requires every setting the server reads to be on it).
- **Tests**: `apps/server/test/shutdown.test.ts` (4: order and exit 0; a throwing step does not stop the lock release, exit 1; a stuck step is cut by the deadline and named, exit 1; a second signal does nothing), `settings.test.ts` (the default). **Scenario `tests/scenarios/shutdown.test.ts`**: the real server holds a raw SSE request on `/v1/stream` (hello read) and an idle keep-alive socket (one answered `/health`, then silence); SIGTERM; asserts exit 0 within 15 s, no deadline line in the output, both connections closed by the server, then a second server boots with the lock (`/health` 200) and stops with 0.

## The launcher chain (the orchestrator's added question)

`launchd → /bin/bash scripts/launch.sh → exec secrets-run run … → /bin/sh -c '… exec bun apps/server/src/main.ts'`. Checked by hand against the installed `~/.local/bin/secrets-run` (a wrapper whose stdout is not a terminal, as under launchd): `launch.sh` and the final `exec bun` replace their processes, so launchd's pid is `secrets-run`. `secrets-run` traps TERM/INT/HUP and forwards them to its child, **which it starts in its own process group** (so it can signal the whole subtree). Test: SIGTERM to the wrapper reached the child's trap, and both ended. So SIGTERM does reach bun through the chain; that part was not the fault.

What explains the orphan seen at the end of window 1 (inference, not reproduced): the old bun never exited (fault 1), `ExitTimeOut` in the plist is 240 s, then launchd SIGKILLed the wrapper. SIGKILL cannot be forwarded, and because bun sits in its own process group, launchd's cleanup of the job's group does not reach it. Bun is left at ppid 1 with its Postgres connections. With the fix, bun ends within 30 s, far inside 240 s, so the SIGKILL never comes in the normal case. I did not show the chain in the scenario: it needs the host's `secrets-run`, which is outside the repo (the rehearsal already boots through `launch.sh` with a fake one).

## `make check`

Green on the fix commit `6a3a46f`, run twice (the second run exited 0). Steps in order: install, format, lint, shellcheck, typecheck, boundaries, retired words, Issue diagram, generated CLI, unit tests, scenarios. One earlier run failed only on `scripts/test/env-file.test.ts` (the new setting was not on the allow-list yet); fixed before the commit. The two runs wrote into one log file, so its tail is interleaved; the figures are from each run's own lines.

```
==> unit tests (bun test apps packages scripts)
 973 pass
 0 fail
 5968 expect() calls
Ran 973 tests across 74 files. [48.65s]
==> scenarios (bun test tests)
 196 pass
 8 skip
 0 fail
 1085 expect() calls
Ran 204 tests across 33 files. [167.16s]
==> check passed
```

The 8 skips are `tests/scenarios/cutover/imported.test.ts` (it runs only under the rehearsal).

## Review

`/review` standard requested; the rule table raised it to **deep** (sensitive path `main.ts`) and I did not lower it. Thread `rw-9b-shutdown`, job `rv_k6o2h7rwmbeixilhlr26`, round 1: outcome **clean**, all five criteria met, one nit:

- `app.stop(true)` also cuts plain in-flight requests (a ship call runs up to 180 s). Disposed **intentional**: a stop that waits for plain requests is the bug itself, the write paths are claim-commit-call-record under deterministic keys (a cut request is retried under the same key, a cut transaction rolls back), and the deadline bounds everything else.
- The reviewer could not verify Elysia's and Bun's stop semantics (no `node_modules` in its worktree); I did, above.

## Open points

- A short grace for plain requests before `stop(true)` (stop accepting and close idle first, wait about 5 s, then cut) would let quick writes finish at a deploy. Not done: the nit was low, and it needs a second `stop` call on Bun's server. Smallest change: in the `server.stop` step, `const s = app.server; await Promise.race([s?.stop(), Bun.sleep(5000)]); await s?.stop(true)`.
- Orphan guard: if a wrapper is ever SIGKILLed, bun still lives on (own process group). A server that stops itself when `process.ppid` becomes 1 would close that hole; not built, it is a design choice for the orchestrator (it would also fire for a server started by hand with `&` and the shell exiting).
- `deploy/com.jkrumm.software-factory.plist.template` still says `ExitTimeOut` 240 s with a comment about the *legacy* start budget (180 s) and its 210 s backstop. The new server's deadline is 30 s; the 240 can stay as an outer bound, but the comment is stale.
- The scenario takes the real stop path only; the deadline's exit-1 path is proved at unit level with an injected `exit` (inducing a hang in the real process would need a test-only route).
