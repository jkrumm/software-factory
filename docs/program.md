# The program: every track from the re-plan, and who runs it

**TLDR.** One program lead (an Opus session in this repo's herdr space) runs all tracks of
`docs/decisions.md` to done. It is not a wave: it holds this page as state, authors each track's
`docs/waves/PLAN.md` in the repo that track changes, spawns those waves in orchestrated mode, reviews every
close-out, and runs tracks in parallel wherever their repos and files are disjoint. It writes no product
code itself.

## The program lead

- **State is this file** (the Tracks table and each track's Status line) plus `docs/waves/handoff/program.md`.
  Rotate at about 60 % context: write the handoff, commit, push, spawn the next rotation
  (`RD_WAVE_MODEL=opus rd wave software-factory 'Read docs/waves/PLAN.md. Execute the active wave (Wave <n>). Follow the /wave skill.'`)
  after flipping this repo's PLAN.md to the next rotation.
- **Per track:** write or update the plan in the target repo (`/wave` skill, "Authoring a plan"), commit and
  push it, spawn with `RD_ORCHESTRATED=1 rd wave <repo> 'Read docs/waves/PLAN.md. Execute the active wave (Wave <n>). Follow the /wave skill, but do NOT spawn the next wave — the orchestrator tab does that after reviewing your close-out.'`,
  block with `wave-watch.sh` (bounded, `timeout`), review the close-out (Left behind, `git log`, the diff:
  a wave's report is a claim, the diff is the proof), then spawn the next wave or fix forward.
- **Parallel:** one active wave per repo; across repos as many as capacity allows. Before each spawn read
  `claude-account usage` and keep each account's reserve; no room means wait, never spill.
- **Inside this repo** the lead's checkout holds docs only. Code waves here run as `rd fan` worktrees and land
  with `rd merge`, so the lead's doc commits never race a worker's.
- **Models:** program lead Opus/high; wave agents Sonnet (the `rd` default); mechanical sweeps Haiku; Opus for a
  worker only for novel hard logic, named in the plan with the reason.
- **Owner contact:** only for the four business classes (product direction, spend, irreversible data loss,
  other people) and security policy, through `ask-human.sh ask`. Own-repo pushes, merges and deploys are
  routine. Everything you write for the owner is short and verdict-first.
- **Stale docs are part of done.** A track that leaves an outdated plan, doc or diagram behind has not closed.

## Tracks

| # | Track | Repo(s) | Needs | Status |
|-|-|-|-|-|
| R0 | Clean setup: no retired wiring, no headless `claude -p` | dotfiles, hermes-agent, vps, brain | — | Done 2026-10-30, reviewed. Two items open, see the track note |
| R1 | Hermes leaves Argo | argo, vps, homelab, dotfiles-private, hermes-agent | — | Done 2026-10-30, reviewed; Hermes loopback bind moved to R0 Wave 2 |
| F0 | Design doc, Effect skill, Effect spike, repo skeleton | software-factory | — | Done 2026-10-30, reviewed: skeleton merged (PR #1), `make check` green, 164 tests. Not deployed: waits for `shared` (F1 Wave 1) |
| F1 | Fleet layer (decisions FL1–FL8); `rd` becomes a client | software-factory, dotfiles | F0, `shared` (A1 Wave 1) | Plan `docs/waves/f1.md` (six waves, each a `rd fan` worker); Waves 1–3 done and reviewed: the server is live, hook events flow, admission, queue states and the role table run. Wave 4 running (`software-factory-f1-w4-rules`, brief `docs/waves/briefs/f1-w4.md`) |
| A1 | Shared database, Argo on the mini, Kuma door, usage v2 schema and price sync | argo, usage-tracker, agent-workflows (outbox), vps, dotfiles, homelab | R1 | Plan in argo (six waves); Waves 1–3 done and reviewed: `shared` exists, usage-tracker and agw write `usage`, Argo reads it (VPS Argo's usage pages answer 500 until Wave 4 runs Argo on the mini); Wave 4 done and reviewed: Argo runs natively on the mini behind a tailnet door (rehearsal data, crons off), agw and Hermes push to it; a second review found a non-atomic stale-lock takeover in `deploy.sh` plus five improvements, handed to Wave 5. Wave 5 (Kuma door) running (`argo-w5`) |
| U | Claude Code cost program on usage v2 | usage-tracker, argo, dotfiles | A1 | pending |
| F2 | Issue machine: inbox, leads in worktrees, evidence, hold, `project.yaml` v0 | software-factory | F1 | pending |
| A2 | Argo pages: Fleet and Factory, agw insight, Infra (Beszel), Usage v2 | argo | A1, F1 | pending |
| I1 | `icon` into `agw image`, the studio app on agw, image-gateway retired | agent-workflows, image-gateway, vps, dotfiles | — | Plan in agent-workflows (three waves); Wave 1 done and reviewed (`agw image-icon` live, byte-identical to the gateway). Wave 2 done and reviewed: the studio reaches agw through the image door (`POST /door/image/*`, bearer from the door tokens), live on the mini, `make verify` checks it; the owner's ImageGen click-through is asked (it gates the gateway's removal, written into Wave 3). Master CI was red after it (BSD `stat -f` in `deploy.sh` on the Linux runner), fixed in `9803d88`. Wave 3 running (`agent-workflows-w3`) |
| IR | iris: fleet, waves and quota screens on the factory API | iris | F1 | pending |
| F3 | Intake and self-heal (Kuma, GitHub, TickTick, Beszel, HyperDX), dedup with the golden set | software-factory | F2 | pending |
| F4 | Capacity classes and the orchestrator; initiatives as child Issues; from here the factory builds itself | software-factory | F3 | pending |
| D | Archive `dotfiles/docs/factory/` (TDD v2.4, report, panel, spikes with their `node_modules`); move the golden set and intervention KPIs here; point `agent-workflows/docs/factory-input.md` and dotfiles docs at this repo | dotfiles, agent-workflows | F0's `docs/design.md`; R0 done (the dotfiles checkout is busy until then) | Done 2026-10-30, reviewed: archived to `dotfiles/docs/archive/factory-v2.4/`, evidence in `docs/evidence/`. `agent-workflows/docs/factory-input.md` repointed too |
| T | oxlint and oxfmt replace Biome (owner, 2026-10-30) | software-factory, agent-workflows | a boundary per repo: `f1-w3-capacity` landed; `agent-workflows-w2` closed and `research-self-improve` idle | software-factory done (PR #5: oxlint 1.90.0 type-aware, oxfmt 0.75.0, zero reformat diff). agent-workflows done 2026-10-30 (PR #71: oxfmt 0.75.0 with Biome's options, an 11-file reformat; oxlint 1.89.0 maps every enforced Biome rule, `noNonNullAssertion` and `useLiteralKeys` dropped as info-level), deployed `74521f1224fb`, `make verify` PASS. Track done |
| L | Later, owner-timed: finances on the mini behind Touch ID; calendar and mail via email-gateway | finances (MacBook), argo, email-gateway | A1 | not started |

## Track notes (the findings each track inherits)

### R0, R1
Plans: `dotfiles/docs/waves/PLAN.md`, `argo/docs/waves/PLAN.md`. R0 Wave 2 carries both close-outs' leftovers.
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
worker's assumption `SPAWN_COST` in `capacity.ts` (1 point weekly, 5 five-hour per unread spawn) is unmeasured.
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

### IR: iris
iris already serves `GET /v1/herd`; its PRD's "Later" list holds quota and the fleet overview
(`iris/docs/PRD.md`). Point those screens at the factory API from F1, not at herdr or Argo directly.
APNs and TestFlight wait on the Apple developer enrolment.
