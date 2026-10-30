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
| R0 | Clean setup: no retired wiring, no headless `claude -p` | dotfiles, hermes-agent, vps, brain | — | Wave 1 running (`dotfiles-w1`); Wave 2 pending |
| R1 | Hermes leaves Argo | argo, vps, homelab, dotfiles-private, hermes-agent | — | Wave 1 running (`argo-w1`) |
| F0 | Design doc, Effect skill, Effect spike, repo skeleton | software-factory | — | next |
| F1 | Fleet layer (decisions FL1–FL8); `rd` becomes a client | software-factory, dotfiles | F0 | pending |
| A1 | Shared database, Argo on the mini, Kuma door, usage v2 schema and price sync | argo, usage-tracker, agent-workflows (outbox), vps, dotfiles, homelab | R1 | pending |
| U | Claude Code cost program on usage v2 | usage-tracker, argo, dotfiles | A1 | pending |
| F2 | Issue machine: inbox, leads in worktrees, evidence, hold, `project.yaml` v0 | software-factory | F1 | pending |
| A2 | Argo pages: Fleet and Factory, agw insight, Infra (Beszel), Usage v2 | argo | A1, F1 | pending |
| I1 | `icon` into `agw image`, the studio app on agw, image-gateway retired | agent-workflows, image-gateway, vps, dotfiles | — | pending |
| IR | iris: fleet, waves and quota screens on the factory API | iris | F1 | pending |
| F3 | Intake and self-heal (Kuma, GitHub, TickTick, Beszel, HyperDX), dedup with the golden set | software-factory | F2 | pending |
| F4 | Capacity classes and the orchestrator; initiatives as child Issues; from here the factory builds itself | software-factory | F3 | pending |
| D | Archive `dotfiles/docs/factory/` (TDD v2.4, report, panel, spikes with their `node_modules`); move the golden set and intervention KPIs here; point `agent-workflows/docs/factory-input.md` and dotfiles docs at this repo | dotfiles, agent-workflows | F0's `docs/design.md`; R0 done (the dotfiles checkout is busy until then) | pending |
| L | Later, owner-timed: finances on the mini behind Touch ID; calendar and mail via email-gateway | finances (MacBook), argo, email-gateway | A1 | not started |

## Track notes (the findings each track inherits)

### R0, R1
Plans: `dotfiles/docs/waves/PLAN.md`, `argo/docs/waves/PLAN.md` (both committed 2026-10-30, spawned by the
re-plan session). The lead takes over their watching and review: `rd agents`, `rd read dotfiles-w1`,
`rd read argo-w1`. R0 Wave 2 starts after Wave 1's close-out is reviewed. Add to R0 Wave 2 if it is not
there: drop `config/settings.template.json` leftovers the Wave 1 close-out lists.

### F0: design, Effect skill, spike, skeleton
1. **`docs/design.md`:** the factory's design from TDD v2.4 (`dotfiles/docs/factory/tdd/03`–`10`) plus
   `docs/decisions.md`. Keep what carries over, rewrite what changed, drop the rest. Data model for the fleet
   (sessions, events, queue, accounts) and the Issue machine (TDD §6's tables). Verdict first, short.
2. **Effect skill** (`.claude/skills/effect/`): `/research` what Effect itself publishes for agents (the
   `AGENTS.md`, `LLMS.md` and `ai-docs/` the package ships, the Effect language service, any official skill or
   docs MCP) and build the skill from it: v4 import paths and renames (`Context.Service`, `catch`), `Effect.fn`,
   `Schema.TaggedError`, `Layer` wiring, `Schedule`, `@effect/sql-pg`, testing with `@effect/vitest` and
   `TestClock`, and the replay-determinism rule. Pin `effect@4.1.0` exactly; tell the agent to read
   `node_modules/effect` before guessing an API.
3. **Spike, rule written first:** one slice built twice by Sonnet workers in `rd fan` worktrees, plain
   TypeScript + zod vs Effect 4.1 with the skill. Slice: a hook event in → session state → a queued spawn with
   a resume-at → a herdr adapter with retries, Postgres-backed, tested. Both get `/code-review` on Max.
   **Effect wins** if its slice has no more review findings than the plain one, no v3-API mistake survives to
   review, and its worker tokens are at most 1.5× the plain one's. Record the numbers in `docs/spikes/`.
4. **Skeleton** in the winning style: Bun workspace, `make check|test|verify|deploy`, CI on hosted runners,
   the `factory` schema migrations, the CLI contract (SF4), release-directory deploy like agw.

### F1: fleet layer
Evidence (wave-maturity investigation, 2026-10-30): quota stalls ~9 times with no automatic resume
(`rd` dies with "paused", `claude-account exhausted` has no caller); turns ended with workers running 6×;
prompts blocking under skip-permissions 4× (folder trust on new worktree paths, dangerous rm); load flakes
~11×; `rd work` dedupes on a live agent, not on the workspace, so spaces duplicate; `rd say` to a busy agent
only queues; prompt suggestions read as owner drafts by the old babysitter. Claude Code 2.1.314 facts:
`docs/research/2026-10-30-claude-code-unattended.md` (`autoContinueAtUsageLimit`, the
`quota_auto_resume_*` and `StopFailure rate_limit` hooks, Notification matchers). Gate: an overnight
multi-wave run across two repos with an injected limit wall and one `drain` needs no owner "continue".

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

### I1: image-gateway
`agw image` already does generate, edit and cutout; `icon` and the studio app's calls are what keep the VPS
gateway alive (`agent-workflows/packages/host/src/workflows/image/README.md` §Icon). The agw host binds
loopback; the studio app on the MacBook needs a tailnet door (the iris pattern).

### IR: iris
iris already serves `GET /v1/herd`; its PRD's "Later" list holds quota and the fleet overview
(`iris/docs/PRD.md`). Point those screens at the factory API from F1, not at herdr or Argo directly.
APNs and TestFlight wait on the Apple developer enrolment.
