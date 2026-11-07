# Package 4: Leads, report

**Done: a lead of an attempt starts in herdr-core, hears its notes once, is followed through hooks, the spool and the hook socket, is sent back when it stops unreported, and is finalized once; the scenarios for start, note, compact, lose a terminal and replay run against the real server process and Postgres.** Branch `rw/4-leads`, off `fc5a8ac`. `make check` is green.

## What changed

- **`packages/contract/src/spool.ts`** (new subpath `@software-factory/contract/spool`, no zod): the spool line, the event kinds, the key counting and the per-session lock, moved from the old core byte for byte; the lock now lives in this module so the hook imports `node:fs` and this module only. **`leads.ts`**: zod bodies and answers (`HookEventBody`, `StopCheck`, `CloseBody`, `DeferBody`, `BlockBody`, `LeadVerbAnswer`, `LeadSession`, `TickAnswer`).
- **`domains/leads/`** (pure): `names` (`lead-<n>-<attempt>`, `factory/<n>-<attempt>`), `session` (state derived from hook facts: `starting`, `working`, `idle`, `compacted`, `gone`, plus `walled`), `brief` (the standing orders, the verbs, the fence, the note budget), `note` (one typed line), `stop` (the send-back decision), `ports`.
- **`app/leads*.ts`**: `leads-start` (`start_lead`), `leads-note` (`note_lead`), `leads-finalize` (`finalize`), `leads-hooks` (`recordHook`, `stopCheck`, spool sink), `leads-follow` (lost terminals), `leads-verbs` (`close`, `defer`, `block`), `leads-session` (the read), `leads-tick` (spool, follow, outbox; `leadPorts`).
- **`adapters/hc/`**: `HcClient`, `HcTerminals` (find by `factory.key` label before acting, space and tab placement, pretrust, prove, type, close), app document seeding, screen reading. **`adapters/git/`**: `gitWorktrees`, `rootedRepos` (the trust boundary). **`adapters/socket/`**: the unix listener. **`adapters/leads/`**: Postgres store, spool replayer (with rotation), transcripts, roles, settings, stubs.
- **`api/leads.ts`**: `issue.close`, `issue.defer`, `issue.block`, `lead.get`. **`api/leads-test.ts`**: `POST /internal/test/tick`, only with `FACTORY_INTERNAL_TEST_ROUTES=1`.
- **`apps/cli/src/hook.ts`** and `bin/factory.ts`: `factory hook <event>`, ported; imports `node:fs` and the spool module only. A boundary rule checks that, with fixtures.
- **`migrations/0400_leads.sql`**: `lead_attempts`, `lead_hook_events`, `lead_deliveries`, `lead_sendbacks`, `lead_finalizations`.
- **Shared files touched, additively**: `main.ts` (store, composition, socket, tick, health), `compose-leads.ts` (new, root layer), `api/app.ts` (two optional deps), `read/health.ts` (`tickProblem`, optional `tickFailure`), `contract/index.ts` and `package.json`, `tests/scenarios/harness.ts` (world socket, spool, archive, pretrust `/usr/bin/true`, `FACTORY_TICK_MS=0`), `fakes/hc.ts` (filled), `scripts/boundaries.ts`, `scripts/retired-words.allow` (one line: `USAGE_LANE=wave` is the usage tracker's lane). Two existing tests loosened so a domain can add commands and migrations: `apps/cli/test/generate.test.ts` (`toContain('health get')`) and `tests/scenarios/boot.test.ts` (`arrayContaining`).

## `make check`

```
==> boundaries (scripts/boundaries.ts)
boundaries hold
==> retired words (scripts/retired-words.ts)
no retired words
==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)
==> generated CLI is current (apps/cli/scripts/generate.ts --check)
==> unit tests (bun test apps packages scripts)
 277 pass
 0 fail
 823 expect() calls
Ran 277 tests across 22 files.
==> scenarios (bun test tests)
 27 pass
 0 fail
 132 expect() calls
Ran 27 tests across 9 files.
==> check passed
```

## Acceptance

Scenarios in `tests/scenarios/leads/`: **start** (one terminal with `factory.key=lead-1-1`, the role's tier and effort, its worktree, `lead_started` recorded, a second tick starts nothing), **note** (an owner's `noted` typed once, the outbox run twice; a second note types only itself), **compact** (the one line for `source: compact`, empty stdout for every other hook, none for a session that is no lead), **lose a terminal** (three `lead_gone`, attempts 2 and 3 started on `admitted`, then a `lead_gone` stall; the repo outside the roots is gone at once), **replay** (hook lines posted twice, spooled lines read twice, the outbox twice: events, hook rows, deliveries, terminals and typed texts unchanged), plus **send-back** (sent back once, stalled `unreported` on the second, ended by the next turn, a report or background work lets the stop through) and **verbs** (close, defer, block, a stale attempt is exit 5, finalize takes terminal and worktree away once). Unit tests: the domain, `start_lead` / `note_lead` / `finalize` / hooks / follow against real tables with fake ports (replay, crash between steps, budget, busy and forced typing, an unconfirmed typing), the adapters (trust boundary, spool replay and rotation, real git worktrees kept or removed), the socket, `/health` staleness. The old hook test (59 cases) and the lock test are ported.

## The ports declared, and the stubs `main.ts` uses

| Port (`domains/leads/ports.ts`) | Real adapter | Wired |
|-|-|-|
| `Terminals` | `HcTerminals` | real |
| `Worktrees`, `Repos` | `gitWorktrees`, `rootedRepos` | real |
| `Roles`, `Transcripts` | `fileRoles`, `fileTranscripts` | real |
| `Seats` (the account of an attempt) | package 3 | `stubSeats`: account `default`, no `CLAUDE_CONFIG_DIR` |
| `Claims` (give the repo claim back) | package 3 | `stubClaims`: no-op |
| `Windows` (when an account's window opens) | package 3 | `stubWindows`: unknown |
| `start_watch` effect port | package 5 | `stubStartWatch`: answers `refused`, so the effect stays pending and visible |

## Events recorded on Issues, and where

- `lead_started` (factory): `start_lead`, key `lead_started:<issue>:<attempt>`.
- `lead_gone` (factory): `start_lead` (refusal or spent budget), `note_lead` (terminal gone), `followLeads` (terminal lost); key `lead_gone:<issue>:<attempt>`.
- `stalled` `wall` (factory): a `limit_stop` hook; `stalled` `unreported` (factory): the second stop of a turn (`unreported:<issue>:<attempt>:<turn>`); `stalled` `blocked` (lead): `issue block`.
- `woken` (factory): a turn that starts after an `unreported` or `wall` stall of that attempt, key `woken:<issue>:<since>`.
- `deferred`, `closed` (lead): `issue defer`, `issue close`.

## Review outcome

`/review` deep, `fc5a8ac..07e4b01`, thread `rw-4-leads`, job `rv_ch4u3vlewb2xgbwuxb7e`: **clean, 0 important, 3 nits**. The first job (`rv_wqmit2biunkci7je55ln`) was abandoned by another worker's prepare on the shared base-keyed thread before I submitted; I prepared again with `--thread rw-4-leads` on the same head and submitted the same reply (same range and files; accepted, outcome clean).

| Finding | Disposition |
|-|-|
| The hook imports `node:path`, the rule says `node:fs` and the spool module | Fixed: the hook builds the spool path by hand; the boundary rule allows exactly those two; fixture added |
| The compaction line and the brief point at `factory issue show`, which does not exist yet | Intentional: the line is AGENTS.md's contract and the read API is package 8; open point 1 |
| A spool line of an unknown kind would be stored and make every read of its session throw | Fixed: `recordHook` checks every line with `HookEventBody`; unit test |

No second round: the brief asks for one.

## Open points

1. **`factory issue show <id>` does not exist** until package 8. The compaction line (`factory issue show issue_<n>`, kept as the contract's one line with the new id), the note fallback and the brief's overflow line name it. The hook line uses `issue_<n>`; package 8 should accept that and the bare number.
2. **The lead's verbs are `--body '<json>'`** because the generator emits a path parameter and a body. The brief teaches `close`, `defer` and `block` exactly, and only points at `factory issue --help` for `ship` and `ask` (packages 5 and 6): their verbs need to be listed in the standing orders at integration. The new word `defer` is mine (the event is `deferred`; the old verb `wait` is not retired but would read as "Wait" the concept). Every verb names its attempt in the body.
3. **The tick is only the leads'.** `compose-leads.ts` runs spool replay, lost-lead follow and the outbox every `FACTORY_TICK_MS` (default 10 s, 0 turns it off; passes may overlap, at most four, because a worktree takes minutes and claims are leased). It sets `tickAt`; `/health` is unhealthy when no pass succeeded for three intervals (at least a minute) or none since start. `queueMovedAt` stays null (the queue is package 3's). Package 7 owns the general loops and should call `leadTick` from its tick or keep this one.
4. **Settings not in `scripts/env-file.sh`'s allow-list** (package 9): `FACTORY_TICK_MS`, `FACTORY_SOCKET`, `FACTORY_SPOOL_DIR`, `FACTORY_ARCHIVE_DIR`, `FACTORY_REPO_ROOTS`, `FACTORY_ROLES_FILE`, `FACTORY_ACCOUNTS_FILE`, `FACTORY_PRETRUST_BIN`, `FACTORY_START_BUDGET_MS`, `FACTORY_GRACE_MS`, `FACTORY_FORCE_NOTE_MS`, `FACTORY_CLAUDE_BIN`, `HC_BIN`, `HC_SESSION`. The pretrust script defaults to dotfiles' when it exists; without it the folder-trust dialog is the owner's.
5. **The new core binds the same hook socket path as the old one** by default. The listener refuses to take over a socket something answers on, so a second server fails to start rather than steal it; the scenarios set their own paths in the harness.
6. **A squash-merged branch is kept, not removed.** `remove` checks "no commit ahead of the base, or a merge that changes nothing"; the old core also used the commits the lead reported as merged, which are evidence (package 5). Kept work shows in `lead_finalizations` and in the next attempt's brief.
7. **The third `lead_gone` is a stall with no `finalize`** (the machine plans none), so the last attempt's terminal and worktree wait for the steward's wake, which finalizes. The scenario pins it.
8. **Transcripts are copied and counted in `lead_finalizations`, not linked as evidence** (package 5 owns evidence).
9. **Words I chose:** the session states `starting` (no hook yet) and `compacted` beside `working`, `idle`, `gone`; `defer`; "delivery" for what was typed into a lead.
10. **Shared-file changes the orchestrator needs to merge:** `main.ts` (the composition line takes every package's store), `api/app.ts`, `harness.ts`, the two loosened tests, `operations.ts` regenerated. `SESSION_STATES` exists in the contract and in the domain (the domain may not import the contract's zod file); a test could pin them equal.
11. **Parallel review threads:** `agw review` keys its thread on the base commit, so parallel workers abandon each other's jobs; use `--thread <package>` (the orchestrator has since said so).
