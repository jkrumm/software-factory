# Decisions: the re-plan of 2026-10-30

**TLDR.** The factory is its own public repo (`software-factory`, CLI `factory`) that owns long-lived state:
projects, Issues, sessions, the queue and capacity. It never calls a model itself; every judgment is an
`agw` workflow. The fleet layer (deterministic babysitting of today's `/wave` sessions, since retired by RS1) is built before the
Issue machine, because the waves are what build everything else. Argo moves to the mini as the analysis
cockpit, iris is the live personal surface, Hermes is the conversation layer behind iris.

Inputs: the owner's voice notes (`feedback/2026-10-30-owner-voice-note-replan.md` and
the chat after it), `agent-workflows/docs/factory-input.md`, TDD v2.4 (`tdd/`, superseded by this page where they disagree;
both lived in `dotfiles/docs/archive/factory-v2.4/`, now only in dotfiles git history, commit `85ee5e5`), the research in `docs/research/`, and four investigations
of 2026-10-30 (Argo and usage, Claude Code setup, wave maturity, infra and iris). Their findings are quoted
in `docs/program.md` where a track needs them. The wave-era mechanisms below (`/wave` sessions, mothers, workers) were retired
by the reset (RS1, RS4, RS11); the notes mark where.

## Surfaces

| Surface | Owns | Never |
|-|-|-|
| **iris app** (iOS, macOS) | voice to Hermes, a live glance at fleet, waves and quota, decision cards, push | analysis |
| **Hermes** | conversation; "do X" becomes a factory request, "how is X going" reads the factory | implements, owns a UI of its own |
| **Argo** | depth: usage and cost analysis, agw telemetry, infra, factory queue and history, life data (health, training, later finances) | chat (Hermes leaves Argo, 2026-10-30) |
| **software-factory** | the lifecycle server and its CLI | a UI: Argo and iris are its faces |

## The factory

| # | Decision | Why |
|-|-|-|
| SF1 | **Own repo, public: `software-factory`.** CLI `factory`. Hosted GitHub runners (public repo) | the lifecycle is long-lived entity state with its own endpoints, adapters and policies; agw's unit is a bounded run. The owner wants to share it |
| SF2 | **The factory never calls a model.** Classify, dedup judge, brief wording, learnings, changelog: each is an `agw` workflow with an eval set | one model runtime, one usage path, one place for evals (`factory-input.md`) |
| SF3 | **Dependencies point one way:** factory → agw, factory → herdr-core, factory → GitHub and the intake sources. agw never knows the factory | no cycle; agw stays a platform anyone can call |
| SF4 | **The CLI copies agw's contract:** `--format json\|plain`, the same exit codes, never prompts, data on stdout | agents learn one convention |
| SF5 | **Fleet first.** F1 builds sessions, hook events, the queue and capacity under today's `/wave` (the wave sessions are retired, RS1; the fleet layer stays); the Issue machine (F2) sits on top | every later track is built by waves; the last two weeks' failures are fleet failures (quota stalls, stuck prompts, duplicate spaces, load flakes) |
| SF6 | **Plain TypeScript and zod, decided by the F0 spike** (`docs/spikes/2026-10-30-effect/verdict.md`): equal review findings, 3.94× the worker tokens against a 1.5× limit. The rule was written before it ran. agw stays plain TypeScript too; Effect Cluster/Workflow is not used | `docs/research/2026-10-30-effect-v4.md`: core Effect 4 is stable with an LTS; cluster, workflow, sql and ai are unstable and break in minors; agents write v3 APIs unless guided; the runtime agw has is what Effect would replace |
| SF7 | **An Effect skill came before the spike's Effect arm,** built from Effect's own agent material (the package ships `AGENTS.md` and `ai-docs/`), removed with the verdict | the spike must measure Effect with the best guidance, not Effect against a model's stale memory |
| SF8 | **Postgres: one shared database on the mini, a schema per writer** (`factory`, `usage`, `argo`); agw keeps its own database `agent_workflows` and grants Argo a read-only role | cost per Issue needs joins across usage and the factory; agw is the critical runtime with its own backups |
| SF9 | **Interactive Claude Code in herdr-core only.** No headless `claude -p` anywhere (two documented exceptions in `dotfiles/docs/agent-platform.md`). Native subagents and agw workflows are the other lanes | headless costs ≈ 1.8× of the 5-hour window per token (claude-code#97074, open); background sessions are still research preview |
| SF10 | **N subscriptions, not two.** Capacity reads the account registry in dotfiles (`config/claude-accounts.json`) | there are three Max accounts today, and the count changes. The order among open accounts is the picker's rank for the `bulk` lane (`claude-account rank`), the gates stay the factory's; no fresh rank falls back to the lowest weekly use |
| SF11 | **The hook socket is a same-user boundary, not a per-session one** (program lead, 2026-10-30, F1 Wave 4). Any process of the mini user can file events and notes for any session: a forged `turn_started` can mark a note delivered, a forged event counts as liveness for the restart rule. Accepted, not bound per session | a same-user process can already type into any pane through herdr's own socket; a per-session credential would add plumbing and no protection. Revisit if the factory ever serves a second user |

Carried from TDD v2.4 unchanged: principles 1–8 (`tdd/03-principles.md`), the lead owns an Issue from root
cause to production evidence (§4), the brief carries the problem and never a diagnosis, the evidence table,
facts stored and state derived (§6), one writer and one inbox per Issue with idempotency keys, no DBOS,
leads in a worktree per attempt, the four business decision classes. F0 folded them into a design document that `docs/architecture.md` and `docs/language.md` replaced at the cutover.

Changed from TDD v2.4: agent-gateway is gone (agw is the platform); the two-account picker is N accounts;
Hermes is behind iris, not Slack; cards and push go to iris, not Argo web push (since Issue 150 the owner's line is ntfy, `NtfyNotifier`); the order is fleet first.

## The fleet

| # | Decision |
|-|-|
| FL1 | **Queue states `run`, `pace`, `drain`,** globally, per project, per initiative. `drain` never interrupts: running waves finish their current wave and the chain stops at the boundary, enforced by the factory: the successor's spawn is held (`queued: drain`) and starts by itself when the drain lifts (program lead, 2026-10-30, after F1's gate run: `rd wave`'s gate refused instead, and nothing restarted the chain). `pace` lowers concurrency and spends only toward weekly pace |
| FL2 | **Resume watchdog.** Claude Code's auto-continue after a limit reset is unreliable in practice (the owner types "continue" often). The hooks record a limit stop (`StopFailure rate_limit`, `Notification quota_auto_resume_*`); after that account's reset, a session with no new turn within about 5 minutes gets one delivery-checked "continue" |
| FL3 | **A spawn without capacity is queued with a resume-at,** never dropped (`rd` dies with "paused" today and nothing retries) |
| FL4 | **One role table** (mother, lead, worker, mechanical, and the subagent types; mother, worker and mechanical are retired by RS4, the table is `config/roles.json`) for model and effort, read by `rd --role` and by agent frontmatter (`effort`). Values move only on measured data (track U) |
| FL5 | **Events, not pane scraping:** Stop, SessionStart, SessionEnd and Notification (`permission_prompt`, `idle_prompt`) hooks write to the fleet's event log; a Stop hook sends a session back when it ends its turn with workers still running and no declared wait |
| FL6 | **One space per repo** (fixed order and `plan:` tab: RS6), keyed by path (the app's folder entry, else a hashed id); a new space only by an explicit flag for a separate plan or worktree |
| FL7 | **A host-wide test-slot semaphore** around `make check` and tests (the load of 60–250 caused ~11 recorded flakes) |
| FL8 | **Deterministic babysitting replaces** `wave-watch.sh` polling, `fleet-keepalive.sh` and the Hermes babysitter cron (all three retired; the wave sessions they watched are gone, RS1) |
| FL9 | **The runner is herdr-core (`hc`), not classic herdr** (program lead, 2026-10-31). `HcRunner` talks JSON-RPC over `hc connect` and the witness follows `events.subscribe`. Why: the core owns the PTYs (they survive the app, a restart and a lost client), reports Claude's status natively (OSC 7501), takes the prompt as the program's argument (no typing at start, no re-send), labels and parents are first-class (idempotence by `factory.key`, hidden worker children), and one core serves the mini and the Herdr app. Costs: no pane cwd to find a space by (the app's document or a hashed id instead), no conversation resume in the core (the restart rule resumes by id as before), the app's document shape is unverified. `HerdrRunner`, the `ps` server probe and the classic fake are removed; the vocabulary is `runner_*` / `agent_*` (migration 010, old names kept one release for a rollback) |

## Argo on the mini

| # | Decision |
|-|-|
| A1 | **Native, like agw:** release directories, launchd, rollback, `make verify`. No Docker, no RollHook. OTel to ClickStack's authed tier |
| A2 | **Argo's API is the dashboard's backend for everything except finances:** it reads the shared database directly and forwards intents to the factory and agw. The finances server is reached on its own, unlocked by Touch ID on the MacBook, key held in memory with a TTL, never in the mini's secrets cache |
| A3 | **Kuma pulls through one door.** One tailnet port on the mini, granted to the homelab only; a registry in dotfiles maps a name to a local health URL; `GET /h/<name>` returns the status and a capped body, GET only. Kuma's monitors are generated from the same registry. Push stays for jobs (backups, cron) |
| A4 | **Infra from Beszel,** which already has agents on all three hosts and a PocketBase API, plus Argo's Docker and Kuma clients (a Docker route for the mini added). No own collector unless Beszel lacks a metric |
| A5 | **agw insight from agw's journal** (read-only role): p50/p95, cost and tokens per fingerprint, tool calls, friction, eval scores, links to traces |
| A6 | Calendar and mail move behind email-gateway later; email-gateway stays on the VPS |

## Usage v2

| # | Decision |
|-|-|
| U1 | **Writers insert into the `usage` schema directly.** usage-tracker's SQLite staging and its 15-minute sync to Argo go; the agw outbox targets the same table. Argo reads, it is no longer the write API |
| U2 | **Sessions are an entity** with their lane: interactive, wave mother, lead or worker, fan worker, subagent type, Hermes, iris, agw workflow, step and route. Plus account, subscription or API key, machine, model, effort, repo, `issue_id`, `run_id` |
| U3 | **No hand-kept prices.** Cost is the provider's reported cost where there is one, else an effective-dated `prices` table synced daily from a public catalog (candidates: models.dev, OpenRouter's models API, LiteLLM's price file; picked by research), else a manual override. Company API spend is reconciled to the portal actuals per key and day |
| U4 | **The dedup key is `(source, source_id)`;** machine is an attribute (the old key produced $3,081 of duplicates). All five token kinds, `cache_write_1h` included. Repos normalised, shared with the factory's projects |
| U5 | **The scarce unit is the Max window,** so the headline is the share of the 5-hour and 7-day windows per session, lane and Issue, not dollars |
| U6 | **A Claude Code cost program** runs on it: a weekly "where the window went" by lane, subagent type, skill context, cache hit ratio and compactions; each finding becomes a change (a subagent's effort, a skill's size, a role's model) whose effect the next week shows |

## Smaller

- **image-gateway retires:** `icon` (upscale, trim, `.ico`/`.icns`, svgo) moves into `agw image`; the
  MacBook studio app talks to agw through a tailnet door; CDN upload and presigned links stay in `imgcli`.
- **warden, agent-gateway, research-gateway, audio-gateway:** archived and deleted from disk after their final
  backups are checked (warden done 2026-10-30).
- **No Biome (owner, 2026-10-30):** oxlint and oxfmt in software-factory, agent-workflows and every new TypeScript
  repo; `bun test` and `tsc` stay, Vite+ is not adopted. Track T in `docs/program.md`.
- **weatherorb's alert issues** stay as they are for now.
- **TDD v2.4 and the rest of `dotfiles/docs/factory/`** are archived in `dotfiles/docs/archive/factory-v2.4/`
  (2026-10-30); the evidence the factory still uses (golden set, intervention KPIs) is in `docs/evidence/` here.

## The reset (owner, 2026-11-05)

Strategy `docs/strategy/2026-11-reset/report.html`, design `docs/strategy/2026-11-reset/design-v3.md`, history
`brain/wiki/engineering/software-factory-history.md`. Tag `pre-reset-2026-11` holds the code before it.

- **RS1 One Issue, one lead, one visible tab.** The lead works through subagents (Explore, implementer, reviewer) and opens
  no terminals. A plan is Issues linked with `--after`; no lead starts or waits for another lead. "Wave" retires as a
  runtime word.
- **RS2 Review once per Issue, tier by rule.** `agw review route` decides none, light (Sonnet medium) or deep (Sonnet high
  plus one verifier per important finding); the lead's own `reviewer` subagent runs it on Max; at most 2 rounds. The
  factory's review transport and hidden reviewer sessions go.
- **RS3 Only decisions reach the owner.** `decision` and `blocked` are asks; `wall`, `lead_gone` and `unreported` are parks
  on a health line, and every park can end without a drop.
- **RS4 The factory shrinks.** Fleet triage, presence, away, digest (the fleet view and its digest stay, RS13), the reaper, the review transport, placement modes and
  the wave-era roles are deleted; finalize is the only closer.
- **RS5 One lead per repo first; parallel leads in one repo later.** Parallel implementation in one project is the goal
  (`leads: N`, review ranges from the merge-base, a real deploy lock), built only after the one-lead loop has run stably.
- **RS6 Spaces are fixed and ready.** One space per repo in a fixed order with a `plan:` tab (a shell) that is never closed;
  the factory keeps them clean.
- **RS7 Apple apps are verified on the mini.** The iOS and Mac apps are deployed to the owner's devices, but verified on the
  mini: simulator and Mac app runs, checked visually by a verifier with screenshots. No owner-verify ask.
- **RS8 The cutover:** Issue 51 closes with what it has; Issues 52–55 are dropped.
- **RS9 Learn on the way.** Every wave of the reset appends to `docs/strategy/2026-11-reset/learnings.md` where it fell
  apart and what the plan changed.

- **RS10 The owner's read (2026-11-05 morning).** The loop runs on through rows 7–9 without another stop, led from the
  owner's session. Changed with it: (a) everything that acts on a turn's end honours `background_tasks` (the Issue send-back
  did, the review transport did not: Issue 67); (b) a new row 7b, the machine budget, before row 10 (design v3 §13);
  (c) a health line about something finished (a failed spawn, an expired note, a dead review) ends after 72 h (row 8);
  (d) row 7 removes `rd fan`, so rows 7b, 8 and 9 are factory Issues chained with `--after`, built and shipped by leads.
- **RS11 Onto the new setup (owner, 2026-11-05 midday).** (a) Everything in design v3 §12 goes, the hidden reviewer included: leads
  review in-session with `/review`, so the transport's refusals ("the reply holds no JSON object") end with it, not with a fix.
  (b) A new row 9b after the contract migration: one read API (Issues, leads, Claude Code sessions, herdr terminals, asks, health,
  one change stream), its spec signed by the owner before it is built (sign-off replaced by RS13); Argo, Iris, Hermes and the sidebar integrate only through it.
  (c) The program runs as Issues from here; no program-lead rotations, the old plans are in `docs/waves/archive/`. (d) WorkRoot repos get
  no factory space or `plan:` tab (replaced by RS15); image-gateway (retired by I1), rollhook-action, ntfy-mac and work-repo-1 leave the sidebar,
  tinycast-extensions gets no space on the mini (dotfiles `159d27c`). (e) basalt-ui is paused. (f) A1's VPS socket-proxy path over the
  tailnet is acceptable, built later when a surface needs it.
- **RS12 The factory governs itself (owner, 2026-11-05 night).** A stalled Issue is the factory's to resolve, not the owner's: a deterministic
  steward in the server acts first (wake, re-check, requeue, deliver), an agw workflow on the cheapest route judges an ask or a spent escalation
  against the plan, and only taste and big decisions reach the owner. Issues 100 (steward), 101 (agw workflow), 102 (wiring, `--after 100 101`),
  ahead of row 8. A watcher in the owner's session is the stopgap this ends. RS3 "every park can end" now means ends by itself.
- **RS13 Build and learn (owner, 2026-11-05 night).** No evals or benchmarks for this work: build it and improve it from real use. Row 9b needs no signed spec: a
  short spec and a working proof of concept, then continuous improvement. Its purpose is ongoing visualizations in the Herdr sidebar and Iris (Argo takes what it can
  get): short titles and summaries in precise plain words with no IDs as display text, and insights on tokens, times and tool calls. Cheap summaries through agw are
  fine, so row 8 keeps the digest code and row 9 its tables until row 9b reuses or removes them. Replaces RS11 (b)'s sign-off.
- **RS14 The plan is a file the server reads (2026-11-06).** The rows of a plan that are not filed yet live in `docs/plan.yaml` per repo, and the server files each as an Issue when the rows it waits for are closed, instead of someone remembering to hand-file them. A row is done when its Issue is closed in any outcome (the meaning of `--after`: a stopped row releases what waits for it). **Amended 2026-11-13 (Issue 1028):** a row may say `after_needs: shipped`; it is then released only by `after` rows that closed `done` or `healed`, and one closed `dropped` or `cancelled` holds it (`waiting`, reason `held: …`) and gets the project a Replan (trigger `held`), whose lead rewrites the plan. The default stays any close; `--after` edges and Issue deferrals are unchanged. "Stable" is no owner touch on any Issue (a note, retier, reopen, stop, or an answer that is not the default, the closing or the steward's) and at least one Issue closed in the last N days. No model is involved; an empty queue with an unfinished plan is a health line, a finished plan is one owner message. The `planning` loop does it (`docs/architecture.md`, "Loops and agw").
- **RS15 Work repos get plan tabs (owner, 2026-11-06).** Replaces RS11 (d)'s "WorkRoot repos get no factory space or `plan:` tab": leads run there now, so the WORK members of
  dotfiles' `groups.json` get spaces and plan tabs like every other repo, and the `WorkRoot` root gets one too, for cross-repo planning. A root is a plan tab only, never a lead's repo.

- **RS16 The role table states what runs (owner, 2026-11-06).** `config/roles.json` now has Explore Haiku/high and verifier Haiku/high, matching `dotfiles/agents/{Explore,verifier}.md`, which is what a lead's subagents run. Measured: the Explore probe spent 5.2k tokens on Haiku against 11.6k on Opus; the verifier used 28M fresh tokens in 30 days, so a Sonnet seat there costs far more for a read-and-report job. Implementer stays Sonnet/high (the table governs `spawn create` and `rd --role`; a lead's `@implementer` runs Sonnet/medium from its agent file). The table governs terminals the factory spawns; in-session subagents take model and effort from the global agent files, the reviewer's seat from `agw review prepare`.

## The next level (owner, 2026-11-07)

Report `docs/strategy/2026-11-next/report.html`, definition `docs/strategy/2026-11-next/definition.html`. These replace the Surfaces table above where they disagree.

- **NL1 One web Console, in this repo.** A PWA, served by the factory's own Bun server, React and Vite, reached over the tailnet. Herdr shrinks to a glance that links to it. Replaces "software-factory: a UI: Argo and iris are its faces".
- **NL2 Iris is a Hermes interface, nothing else.** Simple and public at some point. It may later render UI components, so an artifact view can appear inside it, and may take notifications back. It holds no factory state.
- **NL3 Argo keeps personal dashboards and deep data:** personal API and software usage, health, finance. The factory's own pages and KPIs leave for the Console.
- **NL4 The Console uses shadcn-style components on Base UI and Tailwind 4, with Basalt's colours, fonts, spacing and general feel.** Basalt learns from it afterwards, as its first real consumer on that stack.
- **NL5 Factory first.** Routed alerts go to the door and page nobody directly; the factory's own watchers keep their direct page; an unsolved alert reaches the owner after 30 minutes. Issues 286, 287, 288.
- **NL6 Memory is the limit on parallel leads, not a stable week.** Issues 289 (Iris's automatic builds) and 290 (admission reads memory) come first. The plan's stable-week condition goes when the definition is signed.
- **NL7 MIT, public after Console v0.** The README starts now and improves continuously.
- **NL8 A person reviews a concept rarely.** Holistic UX, product or architecture concepts only, three or four times in a project's life. A new screen, interaction or public text is not a reason. Never a merge.
- **NL9 Fix forward.** No undo records, no restore machinery, no apply guards. A bad change gets a new change.
- **NL10 This is a reference implementation, not a product.** Factory engineers build their own; the repo shares the language, the pain points and the loops that worked.

**Signed (owner, 2026-11-07, afternoon).** `docs/product.md`, `docs/language.md`, `docs/architecture.md` and `docs/rewrite.md` carry the definition with the owner's comments applied.

- **NL11 The core stays plain TypeScript and zod.** A total transition table that fails `tsc` on a missing cell, a Result on every port and a model test give the forcing function Effect was wanted for. Effect stays out of the factory.
- **NL12 Review is the lead's, once per ship range, standard or deep.** Light review goes; static checks cover small changes. The factory never runs or repeats a review; the lead owns its Issue from build to verified production. How much review pays is learned from use.
- **NL13 Pause and rewrite the core** to `docs/architecture.md` on a branch, proven live with `FACTORY_REF`, then resume. The factory builds the Console afterwards.
- **NL14 A temporary orchestrator runs the rewrite** and may start terminals with `hc run` for it, an exception to the two lanes and to RS1 and RS4 that ends at the cutover (`docs/rewrite.md`).
- **NL15 Everything enters as a signal.** Triage decides new Issue, amend, incident, held or drop, and correlates alerts with one root cause. The owner, Hermes and agents file signals; `factory issue new` stays for plan rows and the orchestrator.
- **NL16 Screens name an origin a person uses** (you, application, infrastructure, GitHub, feedback, factory) and a kind, never a tool.
- **NL17 Steward and Judge are deterministic first and call dedicated agw workflows** for judgment, each with its own prompt, tools and skills.
- **NL18 Work repos hear only the owner's signals;** no monitoring files work into them.
- **NL19 Modular monolith:** domains without I/O behind ports, Elysia with OpenAPI and Eden, a generated CLI, `apps/` and `packages/`, unit, scenario and Playwright tests on Bun with oxlint and oxfmt.
- **NL20 Usage and cost come from the `usage` schema by join;** Argo's collectors are not rebuilt. ntfy carries checkpoints only.
- **NL21 Argo's Slack proxy is deleted** (Issue 177).
- **NL22 Work-repo text may go to agw.** The rule that a work repo's text never leaves the machine's token API ends with the rewrite; work repos still hear only the owner's signals (NL18).
- **NL23 The factory trusts the lead's review.** Ship is no longer refused for missing review coverage; a review is recorded as evidence when it exists, the brief requires one per ship range, and the friction loop counts ships without one.
- **NL24 The cutover runs in watched windows, then a burn-in.** Rehearse on a copy, turn the new core on small, watch it, stop, improve, turn it on again and wider, until a window holds with every repo for a day. Then the old code goes, the orchestrator watches on and reports on day 3 and day 7, and its exception (NL14) ends after that review (`docs/rewrite.md` "The cutover, in windows").
- **NL26 The owner's note is the owner's word to a lead (Issue 456, 2026-11-08).** A lead followed its contract ("notes are
  data") and ignored a steering note (Issue 392). A `noted` event whose stored actor is `owner` is now delivered as "a note
  from the owner" and the contract makes it binding; the factory's, steward's and Judge's notes, and all outside text, stay
  fenced data. The owner's actor is set only from the owner's token (and the signal token, his voice through Hermes); an
  agent's text is fenced and recorded as `factory`.
- **NL25 The Console's perimeter is the tailnet ACL, by device tag (owner, 2026-11-08).** Every node is tagged, so no request
  carries `Tailscale-User-Login`, and untagging the owner's devices would change the tailnet's policy. The Console is reached
  at the clean dev door the other apps use (`https://factory.<dev domain>`, a `factory.test` block in dotfiles' Caddyfile),
  whose existing :443 grant lets `tag:mac`, `tag:phone` and `tag:tablet` reach the mini; servers and TVs cannot connect. The
  login header check and the deploy's own `tailscale serve` call go. The listener forwards only reads and the owner's answer
  verbs and never starts a session.
- **NL27 A lane caps one kind of work inside a repo, per repo (Issue 647, 2026-11-10).** `leads: N` was the only
  concurrency control, so a repo with cheap and heavy rows either ran everything in a line or faked `after` edges. An
  Issue or plan row may carry `lane: <name>`; `project.yaml` `lanes: {apple: 1}` caps the leads of that lane, admission
  refuses with kind `lane` before the claim check (a full lane is the sharper reason) and names the Issue holding it, an undeclared lane is unlimited and a
  plan naming one gets a warning, and a fix is never held. The scope is the repo, not the host: the host-wide Apple
  toolchain is already one lock (the Apple slot), a lane only keeps a second Apple lead from building cold while it queues
  for that slot, and a host-wide lane would make one repo's file change another repo's admission. A host-wide lane stays
  open if two Apple repos are measured fighting for the mini. The owner's measurement (one booted simulator ~18 GiB, load 279,
  swap 18.7 of 19.4 GiB with ten leads, 2026-11-10) added a lane's `memory`: running leads of the lane reserve it against
  the memory ceiling, because the admission gate sees a heavy step only after it has started.
- **NL28 A merge needs green CI on its exact head, and a red default branch is a fix (Issue 718, 2026-11-11).** The
  burn-in retro (2026-11-07..10, 308 lead sessions) found a PR merged 17 s after it opened with its CI red 5 min later and
  master red for 4 h, a force-pushed rebase merged with no CI run on it, and a red-master fix queued 3 h 14 min behind a full
  repo. The rules: `scripts/merge-guard.ts` refuses a head with no finished green `ci.yml` run on its exact sha (`--wait`
  polls for it; `--allow-red` never skips it); a master run still running is no refusal, because the head contains
  `origin/master` and its green CI proved that combination, but a red one is; a ship of a PR-shipping project records the PR head's CI as `ci`
  evidence (a push-shipping project records none) and counts red or missing as friction (`unproven_ci`), never refusing (NL23); the Watch does not pass while the
  default branch's run for the landed commit runs or is red; a failing default-branch check is filed as an `incident`
  (the fix's place beyond `leads`, lane-exempt, the line stops) and the leads with an open PR in the repo are noted once.
  The per-account lead cap still holds an urgent fix back; raising it would put a fourth lead on one Max account, so it
  waits for a measured case. **The rebase rule (the second Issue folded in):** a lead runs `make check` before its first
  push and after every change it authors, and a rebase that only brings in master's commits is not re-run locally: CI on the
  rebased head is the same full check and the one the merge needs anyway, so the lead waits once (`--wait`) instead of
  once locally (27-70 min under test-slot contention) and again on CI (12-16 min). Rejected: a path-overlap or docs-only
  rule (a second rule to get wrong, and CI proves it anyway) and a merge queue (a service to build for a problem the
  exact-head rule already closes). Baseline for the measurement the Issue asks for, over the burn-in: `make check` median 3
  runs per Issue (p90 8, max 28), 32 h in 1021 foreground runs across all projects; software-factory Issues closed `done`
  (121): median working time 25 min, median elapsed 96 min. The after is counted from Issues that finish on this rule.
- **NL29 One merge window per repo (Issue 747, 2026-11-11).** NL28's exact-head rule livelocked once five leads ran: CI took
  14-17 min, master took a merge every 5-15 min, and PRs of Issues 664, 714 and 698 were rebased and re-pushed four to five
  times each, every time green on a head that no longer contained master. NL28 had rejected a merge queue; the measurement
  reverses that, but the answer is no service: `factory merge-lock --project <repo> -- <cmd>` is the deploy lock's host-local
  pid symlink under `<project>.merge.lock` (waits 90 min, closed), and the brief has the lead run rebase, push, CI wait,
  `make merge-guard` and merge inside it, so master cannot move under a CI run. The guard's rule is unchanged (no path-overlap
  exception). The same brief line now says the CI wait is `MERGE_GUARD_ARGS=--wait` only where the repo's guard has it
  (iris and basalt-ui do not), else `gh pr checks <n> --watch`. A lead outside the window (a human, a repo without the CLI)
  can still race; the guard refuses it as before. Counted after: rebases per merged PR.

- **NL30 A turn that ends on an API error is answered by class, from the fields (Issue 992, 2026-11-13).** Between 09:47 and
  10:20 UTC Claude Code printed "Please run /login · API Error: 403 Attention Required! | Cloudflare" on all three accounts (typed
  `authentication_failed`, `apiErrorStatus` 403); six leads sat blocked for an hour, because the turn ended with `StopFailure`
  and no `Stop`, the factory's notes waited for a turn end that never came, and herdr-core read the line as a login dialog and
  refused every send. The factory now stores the error (`api_error`), reads it as the turn's end, tells transient from auth by
  `error`, `apiErrorStatus` and the text (a 403 `authentication_failed` is the edge, a 401 is a login), resumes a transient
  one with `continue` after 1, 3, 10, 10 and 10 minutes (staggered across an edge incident), and for a login marks the account
  and raises one Errand. Rejected: a model to triage it (the fields settle it), moving a lead to another account on a 401
  (the lead's session and credentials are the account's; nothing is moved automatically), and `hc send --force` on every blocked
  terminal (a real dialog would take the typed text as its answer: the screen must show the error above an empty prompt). The owner's
  plan sessions are counted in the edge incident's row, never resumed. Counted after: `api_blocked_minutes_per_day`, `api_transient` rows.

- **NL31 A deploy's restart is waited out, measured and coalesced; a gapless handover is not built (Issue 1112, 2026-11-14).**
  The owner found the factory "often down": `deploys.log` held 19, 17 and 13 deploys on 11-12, -13 and -14, each a full stop and
  start of the one process (p50 30 s, p90 214 s, three failed with rollbacks of 10 minutes), and every client failed at once
  (`server unreachable`) for the length of it. Four changes, none a second process: the CLI waits a restart out (a refused
  connection is retried for every verb, because nothing reached the server; a reset or a timeout only for a read, because Bun
  reports a socket closed after connect as `ECONNRESET` whether or not the request was read; 90 s, 10 minutes while the host's
  deploy lock is held by a live pid; one stderr line; `health get`, the hook and `slot run` keep failing at once), the Console
  shows "restarting" and reloads when the stream greets again, `scripts/deploy.sh` writes `unreachable_s=N` (old process told to
  stop to `/health` at the new sha) on its `end` line and `read throughput` sums it per day (`deploys.days`), and the number of
  restarts falls: a deploy that finds its commit live restarts nothing, one whose master moved while it built builds the newer
  commit (3 releases at most), and the migrations are dry-run in a rolled-back transaction before anything is stopped (a refused
  migration is one way to a failed start and a rollback of minutes). Polling the unload and the health every 0.2 s
  instead of every second takes about a second off the window.
  **Gapless handover: not built, and when it would be.** The idea: the new process binds the port (`SO_REUSEPORT`) and takes
  the single-process lock and the loops over from the old one before it exits, so no request meets a closed port. It costs
  what the factory's own rules forbid cheaply: the process lock (`acquireProcessLock`) exists so that nothing runs beside
  another server on the database, the loops (leads tick, outbox, hook socket, SSE streams) would need a hand-over protocol
  with a fence, and a migration that is not backward-compatible with the old code cannot run while both are up. After 1 to 4
  the window is the process start plus the migrations plus a `/health` poll, which `unreachable_s` now measures per deploy, and
  a client that waits it out sees no error. Build it only if the measured figure says so: the median `unreachable_s` of a
  restart above 20 s, or more than 5 minutes unreachable on a day, counted from `factory read throughput`. Before the change
  only the whole deploy (build included) was recorded, so there is no earlier figure to compare; the first measured window is
  the `end` line of the deploy that ships this. Rejected: a proxy in front that holds requests (a second process to keep up,
  and the thing it hides is the thing the clients now wait out), and skipping the restart for commits that touch no runtime path
  (all 50 master commits of two days did).
