# The program: every track from the re-plan, and who runs it

**TLDR.** Since RS11 (2026-11-05) the program runs as factory Issues: the owner's session files each row with
`factory issue new --after …` (or `rd issue`), and the Issue's lead builds, reviews, ships and verifies it. There are no
program-lead rotations or wave plans in this repo any more; the earlier ones are in `docs/waves/archive/`.
The owner's session no longer needs a watcher (RS12): the steward acts on a stalled Issue, and every ask and spent escalation is
judged by `agw factory-ask` first (`docs/design.md` §4 "The ask judge"); only what the plan docs cannot settle reaches him.

## How the program runs

- **State** is this file's Tracks table, `docs/waves/reset.md` (the reset's rows and their Issues) and the factory itself:
  `factory issue list`, `factory status`.
- **A row is an Issue** with `why`, `what`, `change`, `acceptance` facts, chained with `--after`; `factory issue prio` orders a
  project's queue. One lead per repo at a time.
- **Owner contact:** a lead asks only for the four business classes and security policy (`factory issue ask`); everything else is a
  health line. Own-repo pushes, merges and deploys are routine.
- **Stale docs are part of done.** A row that leaves an outdated plan, doc or diagram behind has not closed.

## Tracks

| # | Track | Repo(s) | Needs | Status |
|-|-|-|-|-|
| R0 | Clean setup: no retired wiring, no headless `claude -p` | dotfiles, hermes-agent, vps, brain | — | Done 2026-10-30, reviewed. Two items open, see the track note |
| R1 | Hermes leaves Argo | argo, vps, homelab, dotfiles-private, hermes-agent | — | Done 2026-10-30, reviewed; Hermes loopback bind moved to R0 Wave 2 |
| F0 | Design doc, Effect skill, Effect spike, repo skeleton | software-factory | — | Done 2026-10-30, reviewed: skeleton merged (PR #1), `make check` green, 164 tests. Not deployed: waits for `shared` (F1 Wave 1) |
| F1 | Fleet layer (decisions FL1–FL8); `rd` becomes a client | software-factory, dotfiles | F0, `shared` (A1 Wave 1) | Plan `docs/waves/f1.md` (six waves, each a `rd fan` worker); Waves 1–3 done and reviewed: the server is live, hook events flow, admission, queue states and the role table run. Wave 4 done and reviewed (PR #6, five review rounds, dotfiles `5be93f9`): notes, the resume watchdog, send-back, rotation, blocked and restart rules and `factory status` are live. Wave 5 done and reviewed (PR #7, dotfiles #51): one space per repo, test slots, `rd wave|fan|say|close` go through the factory with today's path as fallback, `drain` enforced in `wave-gate.py`; proven live. Wave 6: the gate passed (PRs #8, #10; `docs/evidence/f1-gate-run/README.md`: nine chains, walls resumed by the factory's `continue`, `drain` held and released both at the factory and through `rd wave`, owner inputs 0; not proven: a real wall stopping a wave mid-work, an injected one does not stop the agent). On the way: a finished chain wave no longer holds its repo (#8), the gate no longer refuses under `drain` (dotfiles #52, FL1 amended), the wake rule (#9: a session waiting `--on workers` gets one note when its last worker finishes). Retired (FL8): `wave-watch.sh` and `fleet-keepalive.sh` (dotfiles #53, the `/wave` skill describes the factory's waiting pattern), the Hermes `quota-nudge` and `Fleet babysitter` crons (hermes-agent #13); a wait on a loaded account names no far-off time (#11). A wake ends the wait it answers (#13). The runner is herdr-core (FL9, `437a4ea`). 2026-11-01 review fixes live (PR #16: spent spawn keys, core-restart resume, resumed finished waves, a missed dead terminal). Left: the gamedays PR #12, built before the herdr-core runner |
| A1 | Shared database, Argo on the mini, Kuma door, usage v2 schema and price sync | argo, usage-tracker, agent-workflows (outbox), vps, dotfiles, homelab | R1 | Done 2026-10-30, reviewed: six waves (plan `argo/docs/waves/PLAN.md`). Argo runs live on the mini (`make verify` PASS `511092e1342c`), the VPS copy stopped with a restore-checked backup on the homelab, the VPS role retired, the dead usage posts removed. Open: the VPS half of `/docker/*` and `/summary` (Hermes' briefing uses them) needs a tailnet path to the VPS socket-proxy, a security call; dropping the stopped VPS schema is asked of the owner (recommendation: wait two weeks) |
| U | Claude Code cost program on usage v2 | usage-tracker, dotfiles, hermes-agent, email-gateway | A1 | Plan `usage-tracker/docs/waves/PLAN.md` (six waves: attribution, window share, cost signals, the weekly report, findings into changes, the effect a week later). U1, U3, U4 done by A1. Waves 1–2 done and reviewed: every Claude Code session carries lane, factory role, effort, subagent type and parent; `usage.session_window_share` and `usage-tracker window` give the 5 h and 7 d share (residual 1–3 %); the FL4 measurement by role waits for a week of factory runs (`usage-tracker/docs/reports/2026-10-30-role-window-share.md`). Wave 3 done and reviewed: compactions, skill loads and cache hit ratio per session and lane (`usage.session_signals`, `lane_signals`). Waves 4–5 done and reviewed: `usage-tracker report weekly` (LaunchAgent Mondays 07:00, Hermes posts it 07:30, first scheduled 2026-11-02), email-gateway spend collected from its OTel spans, the collector's byte offset fixed; findings carry the change that answers them (`usage-tracker/docs/finding-changes.json`): implementer effort high → medium (dotfiles `0b0e61d`); `skill-size:wave` is answered by F1's retirement (the lead adds its `landed` entry). Wave 6 is time-gated: judge on the W46 report (2026-11-16), W45 is a trend |
| F2 | Issue machine: inbox, leads in worktrees, evidence, hold, `project.yaml` v0 | software-factory | F1 | done 2026-11-02: six waves live, the gate passed on its re-run (`docs/evidence/f2-gate/`); plus the door, the notifier and shipped-means-deployed |
| A2 | Argo pages: Fleet and Factory, agw insight, Infra (Beszel), Usage v2 | argo | A1, F1, FV | pending |
| I1 | `icon` into `agw image`, the studio app on agw, image-gateway retired | agent-workflows, image-gateway, vps, dotfiles | — | Done 2026-10-31: three waves, `agw image-icon` live, the studio on agw's image door, the image-gateway retired (agent-workflows `1461a16`) |
| IR | iris: fleet, waves and quota screens on the factory API | iris | F1, FV | pending |
| F3 | Intake and self-heal (Kuma, GitHub, TickTick, Beszel, HyperDX), dedup with the golden set | software-factory | F2 | pending |
| F4 | Capacity classes and the orchestrator; initiatives as child Issues; from here the factory builds itself | software-factory | F3 | pending |
| D | Archive `dotfiles/docs/factory/` (TDD v2.4, report, panel, spikes with their `node_modules`); move the golden set and intervention KPIs here; point `agent-workflows/docs/factory-input.md` and dotfiles docs at this repo | dotfiles, agent-workflows | F0's `docs/design.md`; R0 done (the dotfiles checkout is busy until then) | Done 2026-10-30, reviewed: archived to `dotfiles/docs/archive/factory-v2.4/`, evidence in `docs/evidence/`. `agent-workflows/docs/factory-input.md` repointed too |
| T | oxlint and oxfmt replace Biome (owner, 2026-10-30) | software-factory, agent-workflows | a boundary per repo: `f1-w3-capacity` landed; `agent-workflows-w2` closed and `research-self-improve` idle | software-factory done (PR #5: oxlint 1.90.0 type-aware, oxfmt 0.75.0, zero reformat diff). agent-workflows done 2026-10-30 (PR #71: oxfmt 0.75.0 with Biome's options, an 11-file reformat; oxlint 1.89.0 maps every enforced Biome rule, `noNonNullAssertion` and `useLiteralKeys` dropped as info-level), deployed `74521f1224fb`, `make verify` PASS. Track done |
| FV | (superseded by RS 2026-11-05) Fleet view: one read model (`GET /fleet`) for the board, Iris, Argo and Hermes; digest of short titles, headlines and asks; triage of the human queue and stale plans | software-factory, agent-workflows (digest capability), dotfiles (board, `agw agents` pointer) | F1 | superseded by RS: the triage, presence, digest and reaper go in reset row 8; the board and surfaces wait for the read API (row 9b) |
| RS | The reset: one Issue, one lead, one loop (design v3, decisions RS1–RS11) | software-factory, agent-workflows, dotfiles, homelab | — | active: rows 0–7, 11, 12 live (reset Waves 1–8); row 7b (the machine budget) in flight as Issues 70–72; from Wave 8b on every row is an Issue, then the new row 9b, one read API, before any surface (`docs/waves/reset.md`) |
| L | Later, owner-timed: finances on the mini behind Touch ID; calendar and mail via email-gateway | finances (MacBook), argo, email-gateway | A1 | not started |

## Track notes (the findings each track inherits)

### R0, R1
Plans (archived where done): `dotfiles/docs/waves/PLAN.md`, `argo/docs/waves/PLAN.md`. R0 Wave 2 carries both close-outs' leftovers.
dotfiles `make check` is green again since F1 Wave 2 mapped the new agents (2026-10-30); `drift-check` (collie pin,
tailscale daemon) is still red and outside `make check`. Open after R0: the Hermes API to loopback (`hermes-agent/.env.tpl` `API_SERVER_HOST` and `iris/.env.local.tpl`
`HERMES_HOST` together, then `verify.sh`, the `hermes-validate` probe, restarts, a memo routed to Hermes) waits until
no iris agent is `working`; the Kuma push monitor `Hermes Watchdog - Push` has no pinger and is the owner's to pause
in the UI. Full list of kept sweep hits: `dotfiles/docs/waves/archive/2026-10-clean-setup-PLAN.md`. Dead Argo code for A1 to delete while it moves: the `/ai/v1/*` HTTP
routes (no caller; `aiComplete` stays), `startChatTurn` in the dashboard's telemetry, the 50 MB body limit.

### F0: design, Effect skill, spike, skeleton
1. **`docs/design.md`:** the factory's design from TDD v2.4 (`dotfiles/docs/archive/factory-v2.4/tdd/03`–`10`) plus
   `docs/decisions.md`. Keep what carries over, rewrite what changed, drop the rest. Data model for the fleet
   (sessions, events, queue, accounts) and the Issue machine (TDD §6's tables). Verdict first, short.
2. **Effect skill**, done and removed with the verdict. It pinned `effect@4.0.6`: 4.1.0 and 4.0.7 were inside the
   machine's 3-day release-age cooldown, which is not ours to relax for a third-party package.
3. **Spike, rule written first, done: plain TypeScript** (`docs/spikes/2026-10-30-effect/verdict.md`). One
   slice built twice by Sonnet workers in `rd fan` worktrees, plain
   TypeScript + zod vs Effect 4.1 with the skill. Slice: a hook event in → session state → a queued spawn with
   a resume-at → a herdr adapter with retries, Postgres-backed, tested. Both get `/code-review` on Max.
   **Effect wins** if its slice has no more review findings than the plain one, no v3-API mistake survives to
   review, and its worker tokens are at most 1.5× the plain one's. Record the numbers in `docs/spikes/`.
4. **Skeleton** in plain TypeScript, from `spike/plain` with its review findings fixed: Bun workspace, `make check|test|verify|deploy`, CI on hosted runners,
   the `factory` schema migrations, the CLI contract (SF4), release-directory deploy like agw.

### F1: fleet layer
From the skeleton's review (PR #1), carried into Wave 1: the herdr adapter follows the spike spec (`--name`, exit 3),
not herdr 0.9.3 (`--label`, no exit 3), and drops the prompt, so a `started` spawn has no agent yet; three claims fail a
spawn during a few minutes of herdr restart; `/health` does not see a dead ticker; the CLI casts response bodies. The
worker's per-spawn estimate `SPAWN_COST` was removed in F1 (one new spawn per account per quota sample instead);
track U Wave 2 measures the window share per spawn by role.
Evidence (wave-maturity investigation, 2026-10-30): quota stalls ~9 times with no automatic resume
(`rd` dies with "paused", `claude-account exhausted` has no caller); turns ended with workers running 6×;
prompts blocking under skip-permissions 4× (folder trust on new worktree paths, dangerous rm); load flakes
~11×; `rd work` dedupes on a live agent, not on the workspace, so spaces duplicate; `rd say` to a busy agent
only queues; prompt suggestions read as owner drafts by the old babysitter. Claude Code 2.1.314 facts:
`docs/research/2026-10-30-claude-code-unattended.md` (`autoContinueAtUsageLimit`, the
`quota_auto_resume_*` and `StopFailure rate_limit` hooks, Notification matchers). Gate: an overnight
multi-wave run across two repos with an injected limit wall and one `drain` needs no owner "continue".

Two more failure modes, seen in this program's first rotation (2026-10-30):
- **Account-aware rotation.** A long session stays on the account it started on while the picker moves on. The
  program lead started on `me2` at 90 % of its week; a weekly wall there would strand it for two days, and only
  a human noticed. Today's rule is manual: check `claude-account usage` between tracks, rotate at 94 % (the picker
  skips an account at 95 %). F1 makes this a fleet rule: a long-lived session on an account nearing its weekly
  limit rotates before the wall, not after it.
- **Folder trust on a new repo path.** `rd wave` failed for this repo until `claude-pretrust.sh` ran. The spawn
  path must pre-trust every path it starts in, new repos as well as worktrees.
- **`rd close` refuses a tab not named `wave <n>`,** so a fan tab or a wave in a renamed first tab stays open until
  `rd reap`. The lifecycle should follow the session, not the tab's name.

### A1: shared database, Argo on the mini, Kuma door, usage v2
- **Argo today** (investigation 2026-10-30): Bun, Elysia, Drizzle, Postgres 18 on the VPS (schema `argo`),
  React 19 + Mantine + basalt-ui dashboard, deployed by RollHook; ~68k LOC API, ~71k dashboard; one shared
  bearer. Bridges that flip to loopback: agw overview push and usage outbox, usage-tracker, Hermes narratives.
  Callers on the VPS (email-gateway usage posts) need a port-scoped VPS → mini grant, the same pattern as
  weatherorb's. The OAuth token files move with `DATA_DIR`.
- **Usage today:** usage-tracker SQLite (564 MB, ~840k rows) → HTTP every 15 min → `argo.usage_record`
  (wide table, key `(source, source_id, machine)`). Pains: duplicated pricing (argo `lib/ai-usage.ts` and
  usage-tracker `src/pricing.ts`), no session entity, 6,376 raw project values in 30 days, fragile `sub_tool`
  precedence, no `cache_write_1h` in Argo, 1,631 IU rows unpriced, portal drift 0.42×–2.72×. Docs:
  `argo/docs/usage-reconciliation.md`, `argo/docs/design/usage-tracking.md`, `usage-tracker/docs/collectors.md`.
- Order inside the track: research the price catalog; schema v2 in the shared database; usage-tracker writes
  it directly; backfill history from the VPS table once; agw outbox retargeted; Argo native on the mini
  reading it; the Kuma door with its registry; VPS Argo stopped; ADR-009's VPS role retired.

### T: oxlint and oxfmt
Owner decision 2026-10-30: no Biome. Remove `biome.json`, `@biomejs/biome` and every Biome call. software-factory:
`Makefile`, `package.json`, `AGENTS.md`; gets agw's type-aware step (`oxlint -c .oxlintrc.json --type-aware packages`).
agent-workflows: `Makefile` (the comment, `check`, format), `package.json`, `AGENTS.md`, `docs/concept.md`,
`agents/check/AGENTS.md`, Biome-named comments and suppressions (`rg -il biome packages`); keep its oxlint step and
extend `.oxlintrc.json` to the rules Biome enforced. Start from argo's `.oxlintrc.json` and `.oxfmtrc.json`, with
oxfmt's options set to each repo's current Biome formatting so the diff stays small. The formatting change is its own
commit, separate from the tool swap. Pins clear the 3-day release-age cooldown, never an exclude. Left alone:
`docs/spikes/**`, `docs/evidence/**`, `docs/waves/archive/**`; `agent-workflows/docs/spikes/s3-stack` keeps its
`biome.json`. Vite+ is not part of this: `bun test` and `tsc` stay. Gate: `make check` green in both, `rg -il biome`
only on the excluded paths, agw's `make verify` after its deploy. **Rule for new work:** F1 onward and every new
TypeScript repo use oxlint and oxfmt.

### I1: image-gateway
`agw image` already does generate, edit and cutout; `icon` and the studio app's calls are what keep the VPS
gateway alive (`agent-workflows/packages/host/src/workflows/image/README.md` §Icon). The agw host binds
loopback; the studio app on the MacBook needs a tailnet door (the iris pattern).

### A2: Argo pages
The Fleet and Factory pages read `GET /fleet` and `GET /fleet/since` (FV) through a server-side call with the factory token; Argo builds no
collector of its own for sessions, plans or asks. Usage v2, agw insight and Infra (Beszel) stay Argo's.

### IR: iris
iris already serves `GET /v1/herd`; its PRD's "Later" list holds quota and the fleet overview
(`iris/docs/PRD.md`). Point those screens at the factory API from F1, not at herdr or Argo directly. **FV (2026-11-02):** the fleet,
waves and decision cards read `GET /fleet` (asks with tier and actions) and `GET /fleet/since` (the away card); iris' own `GET /v1/herd`
collector goes; the phone reports `POST /fleet/presence {place: phone, act: foreground|memo}`. Token only, so the token lives in iris' `.env.tpl`.
APNs and TestFlight wait on the Apple developer enrolment.
