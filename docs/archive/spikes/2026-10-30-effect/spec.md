# Spike: plain TypeScript vs Effect 4 (F0 step 3)

**The question.** Do we write the factory in Effect? One slice built twice, by the same model from the same spec.
The rule below is written before either arm runs and does not change after.

## The rule (from `docs/program.md` F0)

**Effect wins if all three hold:**

1. Its slice has no more review findings than the plain one.
2. No v3-API mistake survives to review.
3. Its worker tokens are at most 1.5× the plain one's.

Otherwise plain TypeScript wins.

How each number is taken, fixed now:

| Number | Definition |
|-|-|
| Review findings | every finding `/code-review high` reports on the arm's whole branch diff against master, any severity, after verification (`CONFIRMED` + `PLAUSIBLE`). Same level, same session, both arms. The count is per arm, not per line |
| v3-API mistake | any finding or any line in the final diff using an API from v3 that does not exist in the pinned v4 (a `tsc`-green build cannot hold one, so a hit here means a cast or `any` hid it) |
| Worker tokens | the sum over the worker's session transcript and its subagents' of `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`, read from the transcripts. Output tokens are reported beside it and do not decide |

Both arms: Sonnet, the `rd fan` default effort, one worker, the same spec. A worker that needs steering gets the
same words it would get on the other arm, and the steering is written into the verdict. An arm that fails its own
acceptance is reported as failed; the rule then cannot pass for that arm.

**Version note.** The program named `effect@4.1.0`. That release and 4.0.7 are inside this machine's 3-day
release-age cooldown until 2026-11-01, so the spike runs on `effect@4.0.6`. Everything the slice uses is the same
in both; 4.1.0's breaking change is to `effect/Crypto`, which only Cluster touches here.

## The slice

A hook event comes in, session state is derived from stored events, a spawn without capacity queues with a
`resume_at`, a tick starts it through a herdr adapter with retries. Everything is in Postgres, everything is tested.
`docs/design.md` §2 and §3 describe the real thing; this is a small part of it.

### HTTP (loopback, `PORT` from env, JSON)

| Route | Does |
|-|-|
| `POST /events` | body `{ key, session, kind, at, payload? }`; `kind` is one of `session_started`, `turn_started`, `turn_ended`, `limit_stop`, `session_ended`. Validated (400 on bad input). Stores the event; a repeated `key` changes nothing and answers 200 with `{ "duplicate": true }` |
| `GET /sessions/:id` | `{ id, state, lastEventAt }`, 404 if unknown |
| `POST /spawns` | body `{ key, repo, prompt }`. Picks an account by the capacity rule. Capacity: stores and starts on the next tick. None: stores with `resume_at` set to the earliest reset. Repeated `key` returns the existing row |
| `GET /spawns/:key` | `{ key, status, account, resumeAt, attempts, session }` |
| `PUT /capacity/:account` | body `{ weeklyUsed, fiveHourUsed, resetsAt }`: stores a reading, the fake for `claude-account usage` |

### Rules

- **State is derived on read**, never stored: `starting` (`session_started` and nothing after it), `working`
  (latest `turn_started` has no `turn_ended` after it), `idle`, `walled` (`limit_stop` with no later `turn_started`),
  `dead` (`session_ended`). Order by `at`, then by insertion, because a spool replay delivers late.
- **Capacity:** an account is eligible if the latest reading has `weeklyUsed < 95` and `fiveHourUsed < 85`.
- **Tick:** every 5 seconds, and once on start. Takes due spawns under `FOR UPDATE SKIP LOCKED`, calls the `Runner`
  port, records the result. Exposed for tests as a function, not only a timer.
- **`Runner` port:** `start({ key, repo, prompt }) → { session }`. The herdr adapter runs the command in env
  `HERDR_BIN` (args `tab create --name <key> --cwd <repo>`, stdout is JSON `{ "pane": "..." }`) with retries:
  capped exponential backoff, 5 retries, on non-zero exit only. Exit 2 is permanent: no retry, status `failed`.
- **Deterministic key:** the pane name is the spawn key. A crash between the adapter call and recording the result
  must not start a second pane: the key is recorded first, and the adapter treats "name exists" (exit 3) as success.

### Layout

Own repo root on the arm's branch: `package.json` with exact pins, `tsconfig.json` strict, `migrations/`, `src/`,
`test/`. Bun 1.4.3 runtime, TypeScript 7.0.2.

### Tests that must exist, all green

1. Duplicate event key changes nothing.
2. Each derived state, including a late-delivered event that changes the answer.
3. A spawn with capacity starts on the tick; without capacity it waits, and it starts after a new reading or its
   `resume_at`, without waiting real time.
4. Adapter: retried on a transient failure, stopped on exit 2, success on exit 3, using a fake `HERDR_BIN` script.
5. Replay: a crash injected after the adapter call and before the result is recorded; a second tick starts no
   second pane.
6. Two concurrent ticks start a due spawn once.

Postgres in tests is a private cluster: `initdb -U factory --auth=trust` in a temp dir, `pg_ctl start` with
`-c listen_addresses= -c unix_socket_directories=<dir> -c fsync=off -c port=<free port>`, stopped and removed at the
end. Never touch the mini's main cluster. No secrets.

### Out of scope

Hooks, the spool, real herdr, real `claude-account`, auth, the CLI, deploy, telemetry.

## Result

`docs/spikes/2026-10-30-effect/verdict.md`, once both arms are in.
