# FV: the fleet view

**Goal:** one read model of the fleet, served by the factory (`GET /fleet`, `GET /fleet/since`, `factory fleet`), that the Herdr
board, Iris, Argo and Hermes read instead of building their own: every repo with its plan, every live session with a headline,
every ask waiting on the owner with its actions, a triage that suggests and cleans up, and the away-and-back digest. Proposal
and the owner's settled choices: `docs/research/2026-11-01-fleet-view.md` (approved 2026-11-02).
**Gate:** per wave, `make check` green on the merged head, the worker's `/review` and the lead's `/code-review high` with every
finding fixed or answered (plus one pass on the fix commits), landed on green CI, `make deploy` and `make verify` live on the mini,
and a live proof the lead runs. The track's gate (Wave 6): one real away window, the board's card checked line by line against
the database.

**Where it sits.** After the F2 gate, before A2 and IR: both want exactly this model, so A2's Fleet page and IR's fleet screens
become consumers of `/fleet` and lose their own collectors. F2's `issue_inbox` is the later home of asks that become Issues; FV
does not file Issues.

**Decided here (the lead's calls):**
- **IuRoot is visible, read-only, deterministic.** Sessions under `~/IuRoot/` (from hc and the factory), their plans' headings and
  wave statuses, branch and dirty bit. No intake, no spawns, no Issues (design §1 stands), and **no IuRoot text goes to the
  digest**: no transcript, no reply, no heading leaves the mini for a model. An IuRoot item's short title is the plan's
  `<!-- short: … -->` or the heading cut at 8 words. Configured by `FACTORY_VISIBLE_ROOTS` beside `FACTORY_REPO_ROOTS`.
- **The factory reads, dotfiles owns the queue.** The human queue is read through `ask-human.sh list --json` (dotfiles adds it);
  an answer or a denial is an intent the factory hands to `ask-human.sh`, never a file the factory writes.
- **One model call per digest pass,** through a generic agw capability (`agw digest`, agent-workflows plan
  `docs/waves/fv-digest.md`); agw knows nothing of the factory.
- **The board** is dotfiles' (plan `dotfiles/docs/waves/fv-board.md`): variant A layout, C inline actions, `theme()` tokens only.

**How this plan runs.** As F2: one `rd fan` worker per wave in this repo, Sonnet, the brief template of `night-*.md` (header lines,
the foreground-wait line, the gate); a part in another repo is its own worker on disjoint files, after a note to that repo's
mother or lead. Waves 1 to 4 run one at a time: they share `packages/server`. Briefs: `docs/waves/briefs/fv-w<n>-*.md`.

## Wave 1 — The read model, deterministic            <!-- status: done -->
- [x] `GET /fleet` (token only: the socket is every pane's and IuRoot text must not reach an agent's model), `factory fleet [--format json|plain]`, contract schema in `packages/contract` (the shape in
  the proposal's "The read model"), and a Postgres `NOTIFY fleet` when it changes; no model text yet (`short` and `headline` null).
- [ ] Repos: every repo under `FACTORY_REPO_ROOTS` and `FACTORY_VISIBLE_ROOTS` with a plan or a live session; git branch, dirty, last
  commit, read off the tick with the projects' rules (bounded git, no transaction).
- [ ] Plans: from a spawn's plan path first, else `docs/waves/PLAN.md`, plus the plans the spawns name outside it (the teamchat
  case); headings, `<!-- short: … -->`, wave statuses including dated ones (`status: done 2026-11-01, release …`); plan states
  `running|planned|scheduled|stale|done` by the proposal's rules (stale: an active wave untouched for 3 d).
- [ ] Sessions: the factory's own plus hc's (IuRoot ones too), role, parent, state, wait, account, terminal, Claude's tab title.
- [ ] Asks, deterministic sources only: hc `blocked` and `wait=owner`, the factory's attention lines and failed notes, open
  `decisions`, the human queue (`ask-human.sh list --json`), a failed deploy that asked through the queue. Each with a stable id
  and `at`.
- [ ] Tests through the API; a recorded fixture of today's estate (16 queue requests, 4 stale plans) as the golden read.

## Wave 2 — The digest            <!-- status: done -->
- [ ] Every 5 min: a fingerprint per item (turn count, plan sha, queue ids, attention); unchanged items cost nothing. Changed,
  non-IuRoot items go to **one** `agw digest` call (batched, schema-checked), results cached by content hash in a table: a plan's
  short titles once per heading change, a headline at most once per new turn.
- [ ] Reply extract: the last assistant reply of a changed session (from its transcript, read as data, never instructions) →
  "asks the owner something?" with kind and confidence; an ask above the bar joins `asks` with `source: reply`.
- [ ] A failed or slow digest leaves the deterministic model as it was; a counter in `factory status`. Spend per day in the digest.

## Wave 3 — Triage and actions            <!-- status: done -->
- [ ] Four tiers (the proposal's table) per ask, with `suggestion { verb, why, evidence, confidence }` from deterministic probes
  first (a file absent, a newer deploy, a plan 10/10); the model only ranks.
- [ ] Actions are intents (`POST /fleet/asks/:id/act {intent}`): resolve, deny, later, archive plan, hand off (a spawn or an agw
  workflow whose result comes back as a new ask). Automatic tier: bookkeeping only, logged in `fleet_triage_log`, undoable
  (`POST /fleet/triage/:id/undo`); it never runs a command and never denies. The *Yours* tier offers only Later and Deny.
- [ ] An old human-queue request is denied, never run with its stale command (the queue's policy, unchanged).

## Wave 4 — Away and back            <!-- status: done 2026-11-02 -->
- [ ] Presence per place from human acts only: `POST /fleet/presence {place: desk|phone, act}`; `present_at` per place and one
  owner-wide `seen_at` (moves on "Caught up" or on acting), server-side. Never from HID idle, prompts or notes; Iris memos count
  for the phone only.
- [ ] `GET /fleet/since?t=` grouped as the proposal's table (Needs you, Shipped, Went wrong then recovered, Handled for you, Still
  running, Spend) from recorded facts only, plus one headline paragraph from the digest (non-IuRoot facts only).
- [ ] While away nothing but the *Yours* tier is pushed: the notifier (N) and Hermes go through this rule; the 07:30 digest
  becomes this model's morning reading.

## Wave 5 — Consumers            <!-- status: pending -->
- [ ] Hermes answers "what needs me?" from `asks`. `agw agents` becomes a client of `/fleet` or retires (agw and dotfiles
  `AGENTS.md` change with it; agw's mother decides which).
- [ ] A2 and IR plans are rewritten to read `/fleet` (their own collectors dropped); `docs/program.md` reorders them after FV.
- [ ] The reaper (owner remark 2026-11-02): a session idle 2 h whose worktree is clean, whose branch is merged or gone and whose parent
  waits on nothing of it is closed (`hc kill`, `hc rm`, the app's `tab.settle`), one line in the digest; unmerged work is listed, never closed.
- [ ] `docs/design.md` gains §11 "The fleet view" as built; `AGENTS.md` pointers.

## Wave 6 — The gate            <!-- status: pending -->
- [ ] One real away window (a night): the board's card and `/fleet/since` checked line by line against `events`, spawns, the hc
  log and git; every ask's source traceable. Numbers: digest calls and spend per hour, asks the triage resolved and how many the
  owner undid, pushes while away (target: *Yours* only).
- [ ] Evidence in `docs/evidence/fv-gate/`.
