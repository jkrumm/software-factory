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
| A4 | **Infra alerts come from ClickStack through the door; the factory keeps its own host loop for admission** (`host_samples`, `read machine`: the control loop reads the machine directly). Host and container metrics of the VPS, the homelab and the mini reach ClickHouse through one agent per machine, and the alerts on them post to the same webhook as the app alerts, one route per alert name; `docs/evidence/infra-alert-parity.md` is the proof for every rule that was Beszel's. Argo's Docker and Kuma clients stay. Replaces "Infra from Beszel" (owner, 2026-11-17; Issue 2099 removed the Beszel intake) |
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

- **RS16 The role table states what runs (owner, 2026-11-06).** `config/roles.json` now has Explore Haiku/high and verifier Haiku/high, matching `dotfiles/agents/{Explore,verifier}.md`, which is what a lead's subagents run. Measured: the Explore probe spent 5.2k tokens on Haiku against 11.6k on Opus; the verifier used 28M fresh tokens in 30 days, so a Sonnet seat there costs far more for a read-and-report job. Implementer was Sonnet/medium until 2026-11-17 (NL33) and was Haiku/xhigh from the same day (Issue 2059; the model picker's table: intelligence 34.6 at 0.25 per task against 30.8 at 0.78, about 3.4 times slower, which matters little for an unattended lead) until 2026-11-17 (Issue 2083): CursorBench, a coding-specific per-task measure, put cheap-tier high at 0.423 for 0.32 cost per task against xhigh at 0.443 for 0.56 (1.75 times the cost, 1.9 times the tokens for 2.0 points), so the row is Haiku/high now. Revert: set the row to `{ "tier": "sonnet", "effort": "medium" }`. The global `dotfiles/agents/implementer.md` is the same change, filed there; the table governs `spawn create` and `rd --role`. The table governs terminals the factory spawns; in-session subagents take model and effort from the global agent files, the reviewer's seat from `agw review prepare`.

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
  (iris and basalt-ui do not), else `gh pr checks <n> --watch` after the head has a run (Issue 2143: right after a push the PR has no checks, the watch returns at once and the window ended rc=1). A lead outside the window (a human, a repo without the CLI)
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
- **NL32 A repo's `leads:` is an exception, not the default (Issue 1372, 2026-11-15).** The owner's rule is that only host
  resources and real dependency chains hold work back. Measured 2026-11-14 18:08Z to 2026-11-15 07:30Z (`read capacity-loop`):
  the repo claim was the largest reason seats idled with work queued, 168.8 of 308.5 idle seat-hours over 57 Issues; seat caps
  and account windows cost 0.4 h and 1.6 h. A repo that states no `leads` now takes `DEFAULT_LEADS` = 64, the bound, so
  memory fit, load and the accounts decide. What a cap protected, and what lifting it costs: the repo's merge window
  (one merge at a time, about 10 an hour here; a lead waits up to 90 min for it), rebase conflicts on shared files (98 of 401
  sessions rebased twice or more; budget-ratchet files and migration numbers most), and test-slot contention (a separate
  Issue). A stated `leads: N` stays in force and is a line with its reason beside it. This repo: 5 to 12, where the merge
  window serves a lead within about 1.2 h of its 90 min; expect more rebases per merge, not more waiting past the lock.
  Not changed: the account seat caps, the memory-fit and load gates, `lanes:` (the cap of a truly scarce resource).
- **NL33 Seat by size: mechanical Issues start on a light lead, a struggling one is moved up (Issue 1791, 2026-11-17).**
  Of the 500 Issues closed 2026-11-12 to 2026-11-17, 461 ran on the role table's `lead` row (sonnet, high); a third of the
  done ones took a lead 5 minutes or less. modelpick's table of 2026-11-16: haiku at high effort scores 29.9 at 0.16 a task,
  sonnet medium 30.8 at 0.78, sonnet high 41.5 at 1.64. So the cheap seat is level with the reviewer's at a fifth of the
  cost and 12 points under the lead's: right for mechanical work a check proves, not as the default lead. The role table
  gains `light` (haiku, high). An Issue with no filed seat starts light when `lightRule` (`domains/leads/light.ts`) names
  it: a hygiene finding of a mechanical class (links, retired, context, deps, project, readme, agentsmd, stale), kind docs,
  a monitor filed home for want of a route. The filer's seat always wins. Triage's size is now kept on the Issue
  (`settled.size`); triage's `small` with no design choice joins the rule only once light's first verification pass rate
  is within 3 points of lead's over a week (a switch, off; NL38 replaced it with a measured gate). A light lead that stalls twice, has its ship refused twice, says it is out of its depth
  (`issue block --out-of-depth`) or regresses on its first watch is `moved_up`: the attempt ends, the Issue queues again,
  and the next lead starts on the `lead` row with why and the light lead's last words in its brief. Never twice. Not
  built: a class of alert whose fix is one config line (none is named by a stored fact today), and triage asking for the
  seat itself (agent-workflows' unused `factory.classify` stays unused: the rule is deterministic first).
- **NL34 The lead fit reserves a lead's median peak, not its p80 (Issue 1832, 2026-11-17).** The throughput loop ranked
  host memory the largest queue cost of this repo: 9298 minutes over 7 days, 9283 of it `memory_fit`, a lead that did not
  fit the free memory (shutterflow, basalt-ui, agent-workflows most). Over 2026-11-15 to 11-17 (`read capacity-loop`)
  `memory_fit` held 159 queued hours with 303 idle seat-hours, while memory cost 0.7 idle seat-hours and 3 minutes of pressure
  (swap p50 2.3 %, max 12 % against the 75 % ceiling) and the lead class held a mean 4.6 GiB over 13 to 22 leads. A lead's
  peak is a burst, so the p80 of ten bursts reserved for every candidate (and for every young lead's growth) was far above
  what leads hold together. The figure is now the median (nearest rank) of the newest ten peaks; the `falling` rule, the
  three-attempt minimum, the headroom, the swap and pressure ceilings and the slot grant are unchanged. Cost: a repo whose
  bursts exceed its median is admitted into a host that may then swap; the ceilings stop the next admission, not the burst.
  Revert to 0.8 (`LEAD_SHARE`) if `idleSeatHoursMemory` or `minutesUnderPressure` rises over the three days the loop reads.
  Not changed: the read side's plain p80 (`read/lead-costs.ts`), which shows the burst.
- **NL35 Hygiene, second generation: one catalogue, findings that clear themselves, a daily pass for the cheap probes (Issue 1788, 2026-11-17).**
  Measured 2026-11-17: nine built-in probes ran weekly; nothing cleared a finding whose probe went green; a still-red probe was
  filed again a week after its Issue closed (the intake fingerprint window is 24 hours); `factory read finding-classes` is not
  empty, its fields are `status`, `issues`, `decided`, `noise` and `open` (a query for `state`, `filed` and `dropped` finds
  nothing). So: (1) the catalogue (`packages/contract/src/hygiene-catalogue.ts`) is the one list of probes, with default,
  cost, cadence, seat and how to silence each; `docs/hygiene.md`, the Console's Hygiene tab, `factory read project-hygiene`,
  the `hygiene.skip` keys and the light rule's classes are all read from it. (2) A finding is its key and the Issues that key
  filed (`loop_findings`); its state is derived, never stored. A probe that ran with a verdict and does not raise a key closes
  the key's Issue as healed while no lead has started (the machine allows `healed` only then), and tells a lead at work once;
  a red key whose newest Issue closed done within 29 days reopens that Issue with the evidence (at most twice, then it is left
  to a person and said so), instead of filing a second one; an open Issue holds its finding, so a daily pass adds no note a
  day to a lead at work. The document judgment is never healed: it reads a few documents and absence proves nothing.
  (3) Cheap file probes run in a daily pass, `check`, the tool probes, the project's own probes and the judgment weekly; a
  daily pass becomes a full one when 30 commits landed since the last full pass and it is two days old. Rejected: a new
  table for findings (the Issues already are the state), healing a lead's open Issue (it would race the lead's own ship),
  coverage as a built-in probe (a repo asks for it with a declared probe), `cargo audit` and `pip-audit` beside
  `osv-scanner` (one tool reads every lockfile of ours).
- **NL36 A base test slot keeps no headroom (Issue 1883, 2026-11-17).** `slot_line`'s `base_empty` fired for 8 minutes with
  1 of 2 base slots held and 13 callers waiting, at pressure level 1, swap 3.6 % and no swapouts: 5.9 GiB free, 2.3 GiB of
  growth reserved for the one holder, a 2.6 GiB headroom, so a step needing 2.0 GiB was refused for 1.0 GiB of room. Earlier
  the same symptom came from a frozen head (#1809). The headroom keeps memory for the host itself against the slots
  *beyond* the base; the base is the concurrency the host is sized for, and swap growing, the step's own fit (its learned
  peak plus what the holders still grow by within the free memory) and the lead admission's own headroom still hold.
  Now a step below the base needs `peak + growth <= free`; one beyond it keeps `headroom`. Cost: with two steps running
  the host may sit under 8 % free memory until they end; the next grant waits on swap growing and the fit. Revert by
  using `fit.headroomMib` for every grant in `decide` (`domains/capacity/slots.ts`) if `minutesUnderPressure` or
  `swapoutMib` of `factory read capacity-loop` rises over the three days after.
- **NL37 A regression is friction by rate, not by count (Issue 1990, 2026-11-17).** The `regression` pattern was a bare
  count of 1, so any week with one regressed watch filed an Issue, forever. The week 2026-11-10 to 11-17 had 66 (0.05 per
  Issue closed), read from `quality_watches`: before #1305 (2026-11-15 02:48) 52 of 656 watches regressed (7.9 %), after it 18
  of 590 (3.1 %). The flood was host-wide `make verify` reds charged to the change that happened to be watched
  (dotfiles: 33 of 66, 12 of them on one Issue, a pending macOS update); a replay of the stored checks shows that
  #1305's open-regression baseline already covers the later Issues of such an episode. What is left is mostly the watch
  doing its job: the default branch's CI red on a landed commit (7 of the 18), a `make deploy` that did not run (2, one of
  them a light lead's), a monitor or a bulb that flapped (about 6). The regressed Issue goes back to its own lead, so a
  signal on top of it adds nothing for one. The rule is now 3 in the window and 0.05 per Issue closed (one in twenty,
  the level the week before the fix ran at), judged from `MIN_CLOSED`. Cost: a single regression files nothing; a rise of the
  steady 2 to 3 % to 5 % does. Not changed: `stall:regressed` (a stall twice in a week still files; 1 since the fix) and the
  light seat's move-up on a first-watch regression. Two cases are worth a look if the rate climbs: a light lead that
  forgets `make deploy`, and an environmental red (a bulb, a monitor in PENDING) that moves a light lead up to a Sonnet one.
- **NL38 The light seat widens on what it delivers: finished passes, move-ups priced, a gate that reads (Issue 2026, 2026-11-17; the gate rule is replaced by NL45).**
  NL33's tripwire read light's first-pass rate with every moved-up Issue counted as a failed first pass: 37 of 47 (78.7 %)
  against the lead's 95.6 %, so it could never open. By the seat an attempt ran on, the cheap tier at high effort passed
  37 of 39 (94.9 %): the whole gap was the Issues that moved up, and moving up is the designed valve, not a bad result.
  Now four figures describe what the owner pays for, light beside lead, on the Improve page and in `factory read kpis`
  (`seats.delivery`, each with a one-line definition): (a) the first pass of what finished on the seat, (b) the move-up
  share with the dollars and minutes the light attempt spent before it moved, (c) regressions per Issue, (d) cost per
  Issue with the moved-up attempts counted. The gate (`judgeLightGate`, `seats.tripwire`) is met when, over the last 3
  days, (a) is within 3 points of lead's, (c) is not higher than lead's, and (b) is under the cost bound; with fewer than
  10 finished first watches on light, or a figure unmeasured, it is closed. It is read, not switched: `compose-leads.ts`
  reads it at most every 10 minutes and a window that breaks a condition closes it again. When met, triage's `small` with
  no `checkpoint: spec` starts light, except an Issue whose filing words name a migration, security or a public surface
  (`outOfScope`; triage's checkpoint covers design, a data model, a dependency and an unseen screen, not security).
  The bound is where a light route costs what a lead start costs: every Issue runs a light attempt (`l`), the moved-up
  share `m` then runs a lead attempt (`f`), the lead route costs one lead attempt (`s`): `l + m·f = s`, so
  `m* = (s − l) / f`, from the per-attempt dollars of the window (`f` is the lead attempts after a move-up when there are
  three, else `s`). At the first reading `l` is about 0.15 and `s` 2.7, so `m*` is about 94 %: cost alone allows almost any
  share, and (a) and (c) carry the gate. Cost: a first-watch regression on light still counts in (a) and (c) and moves the
  Issue up; the figures are over three days, so a quiet stretch of rule-class Issues leaves the gate closed.
- **NL39 The reviewer runs on the cheap tier for a share of real reviews (Issue 2027, 2026-11-17).** The owner asked to
  try haiku at high effort as the reviewer: the model picker's table of 2026-11-16 puts it at 29.9 against 30.8 for
  sonnet at medium, at about a fifth of the cost per task. The one offline eval against it (agent-workflows, late October,
  12 paired cases) decides nothing, and the rule is no offline eval: ship it and measure. Leads run `/review` themselves
  and agw routes the seat, so the factory assigns a **reviewer row** at the lead's start (`reviewer-cheap` for a lead on the
  light seat and for an even Issue number, `reviewer` for the rest, stored as `lead_started.payload.reviewer`) and says in
  the brief to pass `/review`'s Agent call that row's tier and effort instead of `prepare`'s `seat` at tier light or
  standard; a deep review keeps agw's seat. At the ship the factory reads each covering review from agw's ledger
  (`agw review covered` names the job, `agw review status <job>` its thread: rounds, findings, dispositions, wall time)
  and stores it in the review evidence with the seat it ran on (`ReviewEvidence.threads`, no migration; the Issue is measured on the evidence of its first accepted ship, the one its first watch followed). `read/kpis-reviewers.ts`
  puts the two seats side by side in `factory read kpis` (`reviewers`) and on Improve. The seat a record names is the
  assignment the brief told the lead to follow, not an observation of the session: the usage side's reviewer cost by model
  (haiku or not) is the cross-check, shown as cost per review. **Tripwire, both ways, from stored facts alone** (no mode is
  kept): the cheap row takes every non-deep review when each seat has 100 non-deep reviews (of the Issues whose lead was not on the light seat: the light Issues are the cheap row's by rule, mechanical and proved by a check, and would flatter it, so the comparison is the even against the odd Issue numbers), the cheap row's Issues regress
  no more often and pass their first verification within 2 points of the other seat's; it goes back to its starting share
  while its last 3 days (judged with at least 10 Issues, so one regression cannot flip it; 10 is a floor of this Issue, not a measurement) break either test against the other seat's whole record, since with every review on the cheap row the
  other seat has no days of its own. Deep reviews stay on `reviewer` until the plain tier has this evidence. Starting share:
  every light-seat Issue and half of the others (Issue number parity). Revert: set `reviewer-cheap` in `config/roles.json` to the `reviewer` row's tier and effort (the assignment
  stays, the seat does not), or delete the row (leads then get no reviewer section and review on agw's seat).
- **NL40 Every hygiene finding starts light; a class that keeps moving up starts on the lead row (Issue 2052, 2026-11-17).**
  The owner said many hygiene runs can use the cheap tier at high effort. Until now only the catalogue's `light` classes did;
  the rest (unused exports, security advisories, the root AGENTS.md byte limit, browser rules) reached the lead row when triage
  sized them medium or left the size empty. A hygiene finding is a probe's, and the same probe turning green proves the fix, so
  `lightRule` seats every Issue with a `loop_findings` hygiene row light whatever its size; the catalogue's `seat` column is gone.
  The move-up path is unchanged. Each class carries its record in `factory read finding-classes` (`seat`: light starts, move-ups,
  finished first watches and their pass rate, and the same over its last 20 Issues). A class is out when, over its last 20
  Issues, the move-up share of the light starts in the window (at least 3) is above the bound of NL38 (`seats.tripwire.bound`,
  `judgeClassSeat`); `seat.out` and `seat.why` say so, and the Improve page lists it with the held classes. Issues of a class
  that is out start on the lead row, so they age its light starts out of the window until fewer than 3 remain: the class is back
  on light with no switch to flip (10 min cache in `compose-leads.ts`). With no bound measured nothing is out. Not changed:
  friction, selfwatch and owner-filed Issues keep NL38's rule; 20 and 3 are floors of this Issue, not measurements.
- **NL41 A block and a full window are friction by rate, not by count (Issue 2187, 2026-11-18).** `stall:blocked` (48) and
  `stall:wall` (21) filed every day on a bare count of 2, one week after `issue_1818` traced the same pattern. Read from
  `factory read waits --days 7`: 48 blocks had a median of 129 s (p90 144 s), 33 ended by the steward and 15 by the factory
  (a timer); 21 full windows had a median of 126 s, 20 ended by the steward moving the lead to an open account; no person ended
  either. 24 of the 48 blocks were re-blocks of 5 Issues that the steward holds on a timer or the owner paused (`issue_867` 8,
  `issue_1067` 6, `issue_1285` 4, `issue_1400` 3, `issue_1300` 3): the designed valve, each wake a new count. The other 24
  were 22 Issues with their own cause (a repo with no CI, an advisory with no fixed version, a light lead that found the work
  bigger, a dirty checkout), none shared by more than two. The 21 walls came in
  three bursts (00:45, 15:20 to 15:32, 21:24 to 21:34 on 2026-11-17), one account's window filling. The rule is now 3 in the
  window and 0.05 per Issue closed for these two keys (NL37's level): the week of the 47-stall loop was 0.07, this week 0.033
  and 0.015. Cost: a block loop under about 70 stalls a week on 1400 closed Issues no longer files by itself; `unreported` and
  `regressed` stay on the bare count. Revert: set `STALL_BY_RATE` back to `{ min: 2, rate: null }`, or delete the two `BY_KEY`
  lines in `domains/loops/friction.ts`. Not changed: the steward's 2 min before it moves a lead (`minStallMs`), which is the
  whole of a wall stall's cost, 6300 s a week.
- **NL42 A ship into a red CI that the last Watch regressed on is refused (Issue 2190, 2026-11-18).** `stall:regressed` filed at 5 in
  7 days. Three Issues were read: 1346 (a dependency bump) shipped the same commits three times into a SonarCloud failure of
  the landed commit and was escalated to a Decision after the third; 2055 re-shipped identical commits four times into a
  host alert that was still firing; 1177 shipped different commits each time (registry drift, real fix-forward). The CI
  case is mechanical: the default branch's CI is a function of the commit, so a ship that lands at the same red re-reads it
  and spends one of the three regressions. A ship is now refused while the default branch's CI of the commit it lands at is
  red, when the Issue's newest Watch regressed on its `ci` check (`watch.ts` `regressedOnCi`, `ciStillRed`); the refusal names
  the red and the exits (a fix or revert, a re-run of a flake, a Decision where the red is not this change's). Green,
  running, missing or unreadable CI never refuses (NL23's rule for evidence stays), and a regression of another check does
  not hold the ship: a missed `make deploy` is cured by an identical re-ship (7 of 10 regressed Issues of 1700 to 2189
  re-shipped the same commits, mostly that). Not changed: the alert case (2055: an incident open before and after the ship
  re-regresses each repeat), `stall:regressed`'s threshold (NL37 left it) and the lead's note. Count over the next week:
  Issues with two or more regressions on the same `ci` sha, and refused ships that name this red.
- **NL43 A repo's dependencies are one refresh, filed past a bar, slower when the repo is idle (Issue 2228, 2026-11-18).** Over the
  last 7 days hygiene filed 164 of 1439 Issues (11 %); the cost was seats, test slots, CI runs, merge windows and deploys, not
  tokens, and test slots bind. The dependency probes filed up to five Issues per repo (basalt-ui: npm, Docker, Actions,
  advisories in two days), each on the day its pass came. Now the `deps` and `advisories` probes hand their rows to one fold
  (`domains/loops/dependency-refresh.ts`): one finding `deps` per repo, a section and a plan per ecosystem, filed only when it
  clears a bar (`HYGIENE_DEFAULTS`): a high or critical advisory with a fixed version; a runtime major (non-dev npm, Cargo,
  Python, Swift, a Docker base image; dev tools and Actions do not file alone); a runtime minor whose latest is 30 days old; or 10
  rows behind in all. Rows inside their cooldown never count. Below the bar nothing is filed and the `deps` run's detail on the
  Hygiene tab names what is behind. An advisory with no fixed version is never filed (osv too; bun already was, #474): it is in
  the `advisories` run's detail and read again each pass. Replayed over the 60 readings of 2026-11-08 to 11-18: 60 filings
  (43 `deps*`, 17 `advisories*`) become 22; the count is flat from 8 to 15 rows and from 14 to 60 days. An idle repo (no commit
  on the default branch for 30 days, read from its newest pass) is swept in full monthly (`deps` and the judgment run only
  then) and in a `steady` pass weekly (the rest); daily file probes and `advisories` keep their cadence, and a commit that
  lands before a steady pass makes it full. A project overrides `idleAfterDays` and `deps.{runtimeStaleDays,behindRows}` in
  `project.yaml` `hygiene:` with its `reason`. Not changed: the upgrade plan and procedure; the class gate. No repo is idle
  today (every one had a commit in the last two days, much of it the factory's own), so the cadence changes nothing yet.
  Known limits: "behind for N days" is the age of the latest version, because first-seen dates are not stored; open Issues
  under the old keys (`deps:docker`, `advisories:bun`) are healed or noted once by the lifecycle, as no pass raises them. Count over
  the next week: `deps` Issues filed against the 43 of the last 30 days, and any repo that went a month with a runtime major
  unfiled. Revert: the numbers are one catalogue edit; the fold is one call in `adapters/hygiene/index.ts`.
- **NL44 A hygiene finding with a mechanical fix is fixed by script, a lead only when the script fails (Issue 2229, 2026-11-18).**
  Hygiene filed 164 of 1439 Issues in 7 days (11 %) at $89 and 20 lead-hours; the cost that mattered was not tokens but the
  seat, test slot, CI run, merge window and deploy each Issue takes, and the test slots were what held 31 of 51 queued Issues
  on 2026-11-17. The probe that finds a thing already proves its fix, so the pass now runs the catalogue's optional `fix`
  (`domains/loops/hygiene-fixes.ts`, scripts in `adapters/hygiene/fixes/`) before it files: the script runs in the sweep's
  throwaway checkout, then the same probe runs again and what it no longer raises files nothing (an unstarted Issue of that
  key is closed as healed by the lifecycle that was there). Two scripts: `stale` deletes the branches the probe calls merged
  and removes merged idle or prunable worktrees (never `--force`; untouched-only branches and worktrees stay a finding);
  `deps` (`bun` only; it runs on the one `deps` finding NL43's bar lets through, and the probe is run again with the advisories) sets each patch or minor past the 7-day cooldown of the root `package.json` with `bun add`, runs
  `make check-fast` (else `check`) under `factory slot run`, and pushes the commit to the default branch of a repo that
  ships by push. A failed fix files the finding with the script's name and output first in its plan, so the light lead starts
  from the failure; no test slot in time is `deferred` (nothing is filed this pass, the next asks again); a version with no
  release date, a major, a held version, a workspace package, a tilde or tagged range and every other ecosystem are a lead's.
  Every attempt is on the pass (`hygiene_passes.fixes`) and the Hygiene tab. The field standard, Renovate with grouped
  patch and minor updates and `automergeType: branch`, was not taken: it runs its check as CI on GitHub's side, never in a
  test slot, needs an app and a config per repo and does nothing for branches or worktrees. Not done: repos that ship by pull
  request (6 of them, this one too) keep their Issue until the factory can hold a PR across passes and a merge window itself;
  a pushed bump is not deployed or watched (the repo's next ship carries it); a push refused because master moved is a failed
  fix, not a retry. Switch: `FACTORY_HYGIENE_FIX=0`. Count over the next week: stale-branch and deps Issues filed against
  `fixes` rows of outcome `fixed`, and how many `failed` ones a lead then closed done.
- **NL46 The bun `deps` fix lands a pull request where a repo ships by pull request (Issue 2264, 2026-11-18).** NL44 left the 6
  `via: pr` repos with their `deps` Issue because a pass could not hold a PR across passes or the merge window. It does not
  have to: the pass already waits on a test slot for up to 100 minutes, so the landing runs inside one pass and keeps no state.
  After the check is green the pass takes the repo's merge window (`factory merge-lock`, the lock a lead's merge takes, held by
  a child that prints "held" and waits on its stdin, so it is let go when the pass closes the pipe or dies), rebases the commit
  onto the default branch's tip (a conflict is `deferred`: the next pass bumps from a fresh master), pushes
  `factory/hygiene-deps`, opens the PR, waits for its CI (30 s polls, 3 min for a first check, 45 min at most), runs the repo's
  `make merge-guard` (else: contains master, master's last finished run not red) and merges by the first method the repo allows
  (squash, rebase, merge; `gh repo view`). Anything that stops it after the PR exists closes the PR and deletes the branch, so a
  lead who gets the finding starts clean; a branch left by a pass that was cut short is closed by the next one. A red CI, no CI
  check, a refused push or merge is `failed` with the check names on the finding; a window not free in 30 minutes, a conflict
  and a guard refusal are `deferred`. `gh` that cannot read the repo (not signed in, not GitHub, no merge method) skips before
  any work. Rule for deploy: none. A merged bump rides the repo's next ship exactly as a pushed one does (NL44); the pass never
  runs `make deploy`, least of all for this repo, whose deploy restarts the server that runs the pass. Field standard: Renovate
  with grouped updates and platform automerge; not taken for the reasons NL44 gives, and it would not run the check in a
  test slot. Not done: Cargo, Python, Swift, Docker and Actions pins, and squash- or rebase-merged branches that
  `stale:branches` does not call merged (a `gh pr list --state merged` read): each is its own signal. Review-gated repos are
  not reached (work repos have no hygiene pass); a repo that requires a human review fails at the merge and goes to a lead.
  Switch: `FACTORY_HYGIENE_FIX=0`. Count over the next week: `fixes` rows of `deps` by outcome for the pull-request repos, the
  merge windows the passes held (`merge_windows` has them only where the CLI had a token) and `deps` Issues filed for them.

- **NL45 The light gate decides on evidence, not on a gap between two small samples (Issue 2226, 2026-11-18).** NL38's gate
  compared point estimates: light's pass rate more than 3 points under lead's, or any regression rate above lead's. The
  reading of 2026-11-18 (3 days: light 71 of 75 finished first watches, lead 515 of 527; regressions 4 of 117 and 12 of 619
  Issues) was 94.7 against 97.7, a gap of 3.06 points, about two Issues, and the gate stayed closed: nearly all default-seat
  work ran on the lead row at about 2.79 dollars an Issue, against 0.30 on light. Over the longer window in `seats.delivery`
  light was within one point and regressed less. The owner's steer: optimise for throughput, extra regressions are
  acceptable, open on numbers like these. Now: (a) the pass-rate condition is broken only when the one-sided 95 % lower
  bound of (lead rate minus light rate) is above `TRIPWIRE_POINTS` (3): Newcombe's hybrid score interval, a Wilson interval
  per rate combined by square-and-add (`passGap`). A small count widens the interval and reads as "not shown worse". Today:
  -0.15 points, open; light 80 of 100: +11.8, closed; 90 of 100: +3.6, closed; 92 of 100: +2.0, open; 8 of 10: +4.5, closed.
  (b) Regressions per Issue are no longer a condition. A regressed first watch of a light lead moves the Issue up and the
  next lead goes forward from the light branch (`brief.ts`, "Moved up from the light seat"), so it is already in the pass
  rate and its follow-up attempt's dollars are already in the cost per Issue and the move-up bound; a third test counted the
  same event again, on counts of 4 and 12. They stay on the Improve page and in `seats.tripwire.regressionGap` (the gap
  and its lower bound), and a limit on them needs a measured line, so none is set. A first design priced a regression at the
  lead row's cost per Issue; it double-counted those dollars and was dropped on the owner's note. (c) The move-up bound's formula is
  unchanged: it is the money condition. It is read over the same window, so the hygiene classes judged against it
  (`judgeClassSeat`, NL40) inherit the window of 3 to 14 days. (d) The window is the last 3 days, reaching back up to 14 until light has 100
  finished first watches (`tripwireFrom`; a Wilson half-width of about 4 points, the resolution at which the 3-point line
  can be seen); `seats.tripwire` carries `days`, `from`, `confidence`, `targetWatches`, `passGap` and `regressionGap`.
  Unchanged: the out-of-scope words, the 10-watch floor (below it the gate is unmeasured and closed), the 10-minute cache,
  `judgeClassSeat` and the closing: a window that breaks a condition closes the gate at the next read. Replaces the gate rule
  of NL38 (its bound formula and figures stand). The confidence (`TRIPWIRE_Z`), the 100-watch target and the 14-day ceiling
  are choices of this Issue, not measurements; 90 % would also open on today's figures and close at 90 of 100. Count over
  the next week: the share of `small` Issues that start light, and their first pass rate and regressions per Issue in
  `seats.tripwire`.
- **NL46 A hygiene class leaves the light seat on minutes as well as dollars (Issue 2230, 2026-11-18).** NL40 judged a class
  against NL38's dollar bound, which is capped at 1: a share cannot pass 1, so no class could leave the light seat on cost.
  `factory read finding-classes` that morning: advisories 4 starts, 4 moved up (share 1), agentsmd 3 starts, 2 moved up, both
  `out: false`, each move-up spending about 19 minutes of a seat and a slot before the real lead started. Now the same
  break-even is read in minutes (`moveUpTimeBound`): a light attempt that finishes saves `lead - finish` against the lead row's
  median Issue; one that moves up has spent `moved` minutes before a lead attempt that takes the lead row's time anyway, so the
  light route breaks even at `share = (lead - finish) / (lead - finish + moved)`. All three are medians (the lead row's working
  ms per Issue, the working ms of light Issues that did not move up, the ms the moved-up attempts ran before moving), as the
  means are skewed by a few multi-hour Issues. Classes are judged against the lower of the two bounds (`classMoveUpBound`,
  `seats.tripwire.bound.classShare`, shown as `bound` in `factory read finding-classes`); a time not measured leaves the dollar
  bound. With no light Issue in the window that did not move up, light has shown no saving: its finish time reads as the lead
  row's and the bound is 0. A light Issue still working counts with its working time so far, as in every other figure here. A first reading used the mean of every light attempt for the light side against the lead's median: it put the bound at
  11 % and 7 of 10 classes out on the day it deployed, so it was replaced by this one. Unchanged: triage's `small` gate still
  reads the dollar bound only, the 20-Issue window, the 3-start floor and the return path (a class that is out starts on the lead
  row, so its light starts age out of the window until the share no longer stands). Cost: a class with a real light win in
  dollars but a slow light attempt can start on the lead row; the first wrong call of the bound is visible in `windowShare`
  against `bound`.
- **NL47 Open-loop estimates are calibrated by the pressure they predict, or they only ever hold work back (Issue 2271, 2026-11-18).**
  At 11:48 UTC 24 Issues were queued for `memory` with 22 of 40 seats idle and load 4.3 of 36. Admission summed 7.5 GiB "free"
  (the factory's own count of anonymous pageable memory plus wired plus compressed), less 4.8 GiB for two young leads, less
  2.6 GiB headroom, against a shutterflow lead of 4.3 GiB: nothing fit. The same minute the kernel read 57 % free, pressure level
  normal, swap 3.5 % and steady, and 0 of 360 minutes at warning or critical in six hours. Over the three days before
  (`read capacity-loop`), `memory_fit` held 364 Issues for 274 queued hours with 357 idle seat-hours, while real swap-out
  pressure cost 1.1. Every margin in that sum was conservative and none was ever checked against what the host felt, so the sum
  could only refuse; it was never wrong in the direction that shows up as a cost. Two controllers also governed one resource:
  the test slots by AIMD on the pressure level, the leads by the open-loop sum. Now one verdict of the host (pressure level, swap
  growth, swapouts, the load tripwire) moves both counts, and the sum is a guard. **Lead admission** (`FACTORY_SLOT_AIM=on`): no
  lead beyond the count the aim holds; the count adds one per two quiet minutes while it binds and halves what runs on a warning,
  swap growth or swapouts. The learned-peak fit refuses only a lead that cannot fit the free memory less what young leads still
  take; headroom is not taken off, since the pressure level is the margin. A missing pressure reading admits nothing beyond what
  runs. **The free memory** is the kernel's `kern.memorystatus_level` when the sample has it: on this host the factory's sum reads
  about 83 % used where the kernel says 69 % free, because the sum counts every anonymous page as in use and the kernel counts
  what the compressor and swap can absorb; the earlier note in `domains/capacity/host.ts` that the free share "lies" (65 % free
  with swap nearly full) is answered by the swap growth, swapout and swap-ceiling signals, which stay. Not taken: a lead's
  footprint as the unit of a single combined budget of leads and slots (a MiB window): the two counts are separate because the
  steps' peaks are learned per step and the leads' per repo, and a combined unit would need both on one scale before it could be
  tuned; revisit if the two counts disagree in `slot_shadow`. Cost: a lead's first minutes burst above its learned figure, so
  the first signs of a wrong call are a pressure level 2 minute or a swap-growth halving in `slot_shadow.reason`; the aim adds
  one lead per two minutes, so 22 idle seats fill in about 45 minutes, not at once. Count after a day: `read capacity-loop`
  `memory_fit` idle seat-hours down and `minutesUnderPressure` near zero. Shutterflow: of its 4.4 GiB lead figure the largest
  process is a `rustc` the lead runs directly (peak 4991 MiB, 84 % of the repo's rustc CPU outside slots); filed to shutterflow
  as signal_01a1ee86, Issue 2272.
- **NL48 A static cap is a claim about a resource, and it is re-checked against measurements (Issue 2269, 2026-11-18).** The owner's rule
  (NL32) is that only host resources and real chains hold work back, and a `leads:` was meant as the exception with its reason
  beside it. On 2026-11-18 11:46, 6 Issues ran, 29 were queued and 22 of 40 seats sat idle (host load 4.3 of 36, no test step
  waiting): 25 of the 29 queued waited on `claim`, the per-repo caps (shutterflow 2 with 18 queued, argo 1, free-planning-poker
  1). Each cap had outlived its premise: argo's comment said "no reason was recorded"; shutterflow's said each worktree has its own
  `target/` of tens of GiB, but targets are APFS clones of the target seed and the largest of 17 worktrees measured 2.1 GiB with
  130 GiB free; free-planning-poker's was the merge window, which `factory merge-lock` serialises. `read throughput` had said
  so a day earlier (54.2 h of queue for a claim over 62 Issues) and nothing acted on it, because no loop turned a binding cap into a
  challenge. Now: (1) **a binding cap is a finding.** When `claim` (a repo's `leads`) or `lane` is the reason an Issue of a repo
  stays queued, and an account seat is idle in the same minute (`host_samples.seats` over `leads`), for 60 minutes or more of
  the last 24 hours (the pass is daily), the throughput pass files one signal on the repo while the cap is still set
  (`domains/loops/caps.ts`, `read/cap-facts.ts`): the cap, the comment beside it in the default branch's `project.yaml`, and the
  measured figures for the resource that comment names (worktree size and free disk, a lead's memory, the merge windows of the
  last 7 days). The title (the cap and the repo) is the fingerprint, so there is no repeat while it is open; the generic
  `queued_minutes` finding for the same claim or lane wait is not filed beside it. Default fix: remove the cap, or raise it to what
  the figures allow. (2) **Disk is admitted by fit.** The host loop measures each running attempt's worktree with its build output
  (`du -sk`, at most every 10 minutes per worktree, 3 per pass; `worktree_sizes`, the largest size per worktree, kept 30 days;
  APFS clones are counted in full, so the figure errs towards refusing) and admission learns a repo's footprint as the p80 of the
  newest ten attempts (at least three, `learnedWorktreeMib`, a size is a plateau, not a burst, so the upper share, unlike the
  memory fit's median). A lead stays queued as `disk` when that figure does not fit the free disk of the home volume less the
  headroom (10 GiB or 5 % of the volume) and what the leads started in the last 10 minutes will still take
  (`diskRefusal`, `youngDiskMib`); with no lead running, no learned figure or no reading it keeps nobody out. A disk reason
  needs no static cap. (3) **`factory project check` and the hygiene `project` probe** warn on a `leads` below the default
  whose comment names a resource the factory models: the merge window (pointer to `factory merge-lock`), the deploy queue
  (`factory deploy-lock`), disk (this fit), and on a comment that records no reason (`capReasonOf`); a cap is for a resource the
  factory does not model. This repo's own `leads: 12`, whose comment was the merge window, is removed for the same reason. Not
  done: a lane cap's wait is not told apart per lane in the finding (every capped lane of the repo is named); the disk refusal is
  not a ranked queue wait (`WAIT_SUBJECTS`) until it shows in the data. Count after a week: no cap finding open for more than a
  day, `disk` queue minutes near zero, and `read capacity-loop` `claim` idle seat-hours down.
