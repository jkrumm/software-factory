# Decisions: the re-plan of 2026-10-30

**TLDR.** The factory is its own public repo (`software-factory`, CLI `factory`) that owns long-lived state:
projects, Issues, sessions, the queue and capacity. It never calls a model itself; every judgment is an
`agw` workflow. The fleet layer (deterministic babysitting of today's `/wave` sessions) is built before the
Issue machine, because the waves are what build everything else. Argo moves to the mini as the analysis
cockpit, iris is the live personal surface, Hermes is the conversation layer behind iris.

Inputs: the owner's voice notes (`dotfiles/docs/factory/feedback/2026-10-30-owner-voice-note-replan.md` and
the chat after it), `agent-workflows/docs/factory-input.md`, TDD v2.4 (`dotfiles/docs/factory/tdd/`,
superseded by this page where they disagree), the research in `docs/research/`, and four investigations
of 2026-10-30 (Argo and usage, Claude Code setup, wave maturity, infra and iris). Their findings are quoted
in `docs/program.md` where a track needs them.

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
| SF3 | **Dependencies point one way:** factory → agw, factory → herdr, factory → GitHub and the intake sources. agw never knows the factory | no cycle; agw stays a platform anyone can call |
| SF4 | **The CLI copies agw's contract:** `--format json\|plain`, the same exit codes, never prompts, data on stdout | agents learn one convention |
| SF5 | **Fleet first.** F1 builds sessions, hook events, the queue and capacity under today's `/wave`; the Issue machine (F2) sits on top | every later track is built by waves; the last two weeks' failures are fleet failures (quota stalls, stuck prompts, duplicate spaces, load flakes) |
| SF6 | **Effect decided by a spike (F0)**, rule written before it runs (`docs/program.md` F0). agw stays plain TypeScript either way; Effect Cluster/Workflow is not used | `docs/research/2026-10-30-effect-v4.md`: core Effect 4 is stable with an LTS; cluster, workflow, sql and ai are unstable and break in minors; agents write v3 APIs unless guided; the runtime agw has is what Effect would replace |
| SF7 | **An Effect skill comes before the spike's Effect arm,** built from Effect's own agent material (the package ships `AGENTS.md`/`LLMS.md` and `ai-docs/`), repo-scoped in `.claude/skills/effect/` | the spike must measure Effect with the best guidance, not Effect against a model's stale memory |
| SF8 | **Postgres: one shared database on the mini, a schema per writer** (`factory`, `usage`, `argo`); agw keeps its own database `agent_workflows` and grants Argo a read-only role | cost per Issue needs joins across usage and the factory; agw is the critical runtime with its own backups |
| SF9 | **Interactive Claude Code in herdr only.** No headless `claude -p` anywhere (two documented exceptions in `dotfiles/docs/agent-platform.md`). Native subagents and agw workflows are the other lanes | headless costs ≈ 1.8× of the 5-hour window per token (claude-code#97074, open); background sessions are still research preview |
| SF10 | **N subscriptions, not two.** Capacity reads the account registry in dotfiles (`config/claude-accounts.json`) | there are three Max accounts today, and the count changes |

Carried from TDD v2.4 unchanged: principles 1–8 (`tdd/03-principles.md`), the lead owns an Issue from root
cause to production evidence (§4), the brief carries the problem and never a diagnosis, the evidence table,
facts stored and state derived (§6), one writer and one inbox per Issue with idempotency keys, no DBOS,
leads in a worktree per attempt, the four business decision classes. F0 folds them into `docs/design.md`.

Changed from TDD v2.4: agent-gateway is gone (agw is the platform); the two-account picker is N accounts;
Hermes is behind iris, not Slack; cards and push go to iris, not Argo web push; the order is fleet first.

## The fleet

| # | Decision |
|-|-|
| FL1 | **Queue states `run`, `pace`, `drain`,** globally, per project, per initiative. `drain` never interrupts: running waves finish their current wave and the chain stops at the boundary, enforced in `rd wave`'s gate. `pace` lowers concurrency and spends only toward weekly pace |
| FL2 | **Resume watchdog.** Claude Code's auto-continue after a limit reset is unreliable in practice (the owner types "continue" often). The hooks record a limit stop (`StopFailure rate_limit`, `Notification quota_auto_resume_*`); after that account's reset, a session with no new turn within about 5 minutes gets one delivery-checked "continue" |
| FL3 | **A spawn without capacity is queued with a resume-at,** never dropped (`rd` dies with "paused" today and nothing retries) |
| FL4 | **One role table** (mother, lead, worker, mechanical, and the subagent types) for model and effort, read by `rd --role` and by agent frontmatter (`effort`). Values move only on measured data (track U) |
| FL5 | **Events, not pane scraping:** Stop, SessionStart, SessionEnd and Notification (`permission_prompt`, `idle_prompt`) hooks write to the fleet's event log; a Stop hook sends a session back when it ends its turn with workers still running and no declared wait |
| FL6 | **One herdr space per repo,** keyed by path; a new space only by an explicit flag for a separate plan or worktree |
| FL7 | **A host-wide test-slot semaphore** around `make check` and tests (the load of 60–250 caused ~11 recorded flakes) |
| FL8 | **Deterministic babysitting replaces** `wave-watch.sh` polling, `fleet-keepalive.sh` and the Hermes babysitter cron |

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
- **weatherorb's alert issues** stay as they are for now.
- **TDD v2.4 and the rest of `dotfiles/docs/factory/`** are archived once `docs/design.md` here holds what
  carries over; the evidence the factory still uses (golden set, intervention KPIs) moves here.
