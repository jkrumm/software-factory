# Architecture: what is built

**A modular monolith on Bun: plain TypeScript and zod, Postgres as the only store, domains with no I/O behind ports,
Elysia at the edge, and a generated CLI.** It has been the running factory since the cutover of 2026-11-08
(`docs/rewrite/state.md` is the log of how it got here). Words follow `docs/language.md`; the rules a change must keep
are in `AGENTS.md`; why something is as it is, in `docs/decisions.md`. This page says where things are and how they fit.
What is not built yet is the last section.

## Layout

```
apps/
  server/     Elysia app: domains, application services, adapters, read models; migrations in apps/server/migrations
  door/       the alert door: loopback, one token (`machine`), posts alerts and refusal reports to the server
  cli/        `factory`: commands generated from the OpenAPI document, plus the hook, slot, deploy-lock, merge-lock, follow, role and issue schema verbs
packages/
  contract/   zod schemas: every request, response and event; the OpenAPI source; the spool format the hook shares
  client/     typed client (Eden) and the CLI's transport, including the change-stream follower
tests/
  scenarios/  use cases run against a real server and Postgres with fake hc and agw: the acceptance suite
config/       roles.json (tier and effort per role), infra.json (the Beszel thresholds)
scripts/      deploy, verify, launch, env-file, the boundary and retired-word checks, the cutover tools
deploy/       LaunchAgent templates
```

## The server

```
apps/server/src/
  kernel/        Result, ids, clock, keys, the event envelope, agw call types. Imports nothing else
  domains/       pure: types, rules, state machines, ports (interfaces). No I/O, no SQL, no Elysia
    intake/        signal envelope, trust and routing rules, fingerprints, incidents, the Beszel rules
    planning/      projects, plans, the chain, queue order
    capacity/      accounts and windows, memory, load, repo claims, queue state, test slots, admission
    work/          the Issue: events, the total transition table, effects, the generated diagram
    leads/         attempts, the brief, notes, session state derived from hook events, the stop rule
    quality/       the ship gate, evidence, the watch and verify
    checkpoints/   Decisions, artifacts and revisions, errands, the owner's pages
    loops/         what the steward and triage decide: stall rules, settling
  app/           use cases: one transaction to claim, the port call outside it, one to record
    loops/         the loop runner and the steward and triage passes
  adapters/      postgres stores, hc terminals, agw, git, ntfy, filesystem blobs, the intake pollers, the hook socket, the uptime poller (`adapters/uptime/`: Argo's Kuma snapshot, `uptime` of `GET /v1/overview`: up, down, total, at most 10 down names, null when `FACTORY_UPTIME_URL` is unset, never read or older than 10 min; `FACTORY_UPTIME_TOKEN`, `FACTORY_UPTIME_EVERY_MS` default 60 s)
  api/           Elysia route groups, auth and the caller policy
  read/          read models (SQL projections) for the API and the stream
  compose-*.ts   wiring of each domain; main.ts boots, takes the process lock first and shuts down in order
```

**Rules, enforced in `make check` by `scripts/boundaries.ts`:**

- `domains/*` import only `kernel` and their own folder. A domain reaches another only through `app/`.
- Each domain owns its tables. `read/` crosses them and is read-only.
- A port is an interface in its domain; an adapter in `adapters/` implements it; tests use fakes of the same interface.
- Only the unit of work, the migration runner and the read models' bounded read (`read/bounded.ts`: read-only, with a statement timeout) open a transaction. A port is never called inside one: claim,
  commit, call, record.
- Every port returns `Result<T, PortError>`; only a programming error throws. `PortError.kind` is `timeout`, `gone`,
  `refused` or `unreadable`.
- An intake poller reads the outside world and hands signals to the sink; it touches nothing else of the server.
- `apps/cli/src/hook.ts` imports only `node:fs` and the spool half of the contract.

## The Issue machine

States: `settling`, `queued`, `working`, `waiting`, `watching`, `closed`. `apply(state, event)` is a total table in
`domains/work/table.ts`: every `(state, event)` cell is written down as a transition with its effects, a named refusal
or a named ignore, and a missing cell fails `tsc`. The diagram and the wait table in `docs/language.md` are generated
from that table.

- **One writer.** `app/` stores the event, the new state (`UPDATE … WHERE id = $1 AND version = $2`) and the effects in an
  outbox in one transaction, then the outbox runs the effects (`app/outbox.ts`): claimed with a lease, retried with a
  doubling delay. A late event that names an old attempt, watch, wait or checkpoint is ignored or refused by the table.
- **A review wait takes Decisions.** While an Issue waits for the verdict on a Concept or Spec, the lead may raise and amend
  Decisions about it (`wait.decisions`, each linked by `decisions.artifact_id`; the steward's ask stays stall-only). The wait
  keeps its `since` and `told`, and ends when the verdict is given and every such Decision is settled, in either order
  (`verdictGiven` marks a verdict that came first): one `note_lead` then covers the verdict and the answers. Needs lists
  the Decision with its `artifact`, and the review item only until the verdict is given.
- **Model test** (`apps/server/test/work/model.test.ts`): a seeded generator plays random event sequences and checks
  invariants: a machine wait always has an exit that needs no person; a wait on the owner always states what it holds (a review wait with Decisions open leaves in steps: the verdict and each answer); a
  closed Issue reopens only by its verb, within 30 days.
- No XState, no workflow engine. Events in Postgres plus a row version are the whole mechanism (NL11).

## Signals and triage

Every input is one envelope (`source`, `kind`, `origin`, `trust`, `repo`, `fingerprint`, `title`, `text`, `link`) and goes
through `receive` in `app/intake.ts`; the answer is a triage outcome (`docs/language.md`).

- **Sources.** The owner (`factory signal`, Hermes through the narrow `signal` caller as `owner:hermes`), agents
  (`agent:<repo>`), the alert door (Kuma and HyperDX), and three pollers: GitHub (the owner's new issues and failing
  checks, a failing one filed as an `incident` so it takes the fix's place beyond the repo's `leads` and the lead of every
  other Issue of the repo with an open pull request is noted once; anyone else's need the label and are held), Beszel (host rules from `config/infra.json`) and launchd (a
  LaunchAgent's state). `repo` comes from the route, the door registry or the caller, never from an outside payload.
  **App feedback** is a door source of its own: `POST /feedback/<app>` with the app's token (`feedback-<app>` in the door's
  tokens file) becomes `POST /signals/feedback`, one envelope for every app (`FeedbackRequest`: app, version, route, title,
  text, link). It is a signal from `feedback:<app>`, trust `outside`, whose text opens with an `app/version/route` header;
  the repo is the door route `(feedback, <app>)` or none, and the fingerprint is the repo (or app) and the title, never the
  version or route, so one complaint from two builds is one.
- **Backlog sweep.** With `FACTORY_GITHUB_BACKLOG=1` the GitHub poller's first pass after a start also reads every open issue
  of each polled project (oldest first, pull requests out) and files it through `receive`: the label's and the author's as
  `machine`, everyone else's `outside` (held). It carries `writeback: false` and no `admitted`, so nothing is ever written to
  GitHub for it (promoting a held one keeps that); one `github backlog:` log line per issue says the outcome. A replay is idempotent (the subject and event keys), and a sweep
  that could not read a repo whole runs again on the next pass. Unset it after the sweep.
- **Who may file where.** `domains/intake/rules.ts` gates a signal: a work repo hears only the owner (NL18), an unknown
  repo hears no one, and a project hears the automatic sources its `signals:` lists. The door's and Beszel's are routed.
- **Incidents.** Alerts of the monitoring sources on one host or dependency inside a window join one incident: the VPS
  down fires Beszel, HyperDX and Kuma, and there is one Issue. The window is a setting (`FACTORY_INCIDENT_WINDOW_MIN`).
- **Amend or new.** A repeat of a fingerprint inside its window changes nothing. An owner or agent signal that matches an
  open Issue clearly (title overlap) amends it and reaches its lead as a note. Otherwise, unless a fingerprint, subject or
  open incident already settles it, the `factory-triage` workflow sees the repo's open Issues and those closed in the last
  day (outcome, reason) and answers amend `<open Issue>`, "already settled: `<closed Issue>`" or neither (file anew): a
  settled answer acks `dropped`/`settled` and stores the signal dismissed by the judge, for a person's request and for a
  `down` alert alike. The workflow side (agent-workflows `factory-triage`) must learn `settled`; until it does the extra
  input is ignored and `settled` never comes back, which is today's behaviour. A `down` waits out a heal grace as `held`: an `up` inside it makes it `healed`, and a project's heal rule runs
  `make restart` in its repo (`adapters/intake/runbook.ts`, outside any transaction) before an Issue is filed.
- **Quarantine.** An outside signal is held and reaches a lead only when the owner or the Judge promotes it, fenced as data.
  Promoting keeps a subject row for the signal's fingerprint (as for a person's request). A later outside signal with that
  fingerprint from the same source amends the promoted Issue while it is open (a `noted` event, fenced; the signal is stored
  `amended`, once per distinct text); when that Issue is closed it is held again as new, and while a signal is still held a
  duplicate is that held signal (`replayed`, no second row). A held signal can also be **dismissed** (`POST /signals/:id/dismiss`,
  the owner or the Judge, a reason of 1 to 500 characters): state `dismissed` with `dismissed_reason`, `dismissed_by`
  (`owner`, `judge` or `probe`) and `dismissed_at`, no Issue, and it leaves Needs you and the friction count. Only a held
  signal can be dismissed or promoted; a later signal with a dismissed one's key is a new report, held under that key extended with the dismissed id (and so on down the chain). A **probe** (`probe: true` on `POST /signals` or the door's feedback, carried on the
  `Signal` envelope) passes the loop guard, the work-repo rule and the trust gate as any signal does, then is stored
  `dismissed` by `probe` under a key of its source and fingerprint (a replay stores once): it files nothing, is never held and
  never reaches the triage workflow; its ack is `dropped`, detail `probe`.
- **Screen.** The `screen` loop (below) has the Judge look at held signals. Prompt injection: the workflow's verdict can only
  promote, dismiss or leave the one signal it was shown (a `leave` stores `screen_note`, `screened_at`; the Console shows it as
  "Judge: ..." above Promote and Dismiss); a promote files an Issue whose text is still outside text, fenced as data in the
  lead's brief, as the owner's promote does. A newly held signal waits for the next pass (no kick; the interval is
  `FACTORY_LOOP_SCREEN_MS`, 10 minutes at least).
- **Loop guard.** A change a loop made never fires that loop again.
- **Stop the line.** While a repo's alert is unsolved, only its fix is admitted.

## Capacity and leads

- **Admission** (`domains/capacity/admission.ts`) is pure and decided again at every claim, in this order: queue state
  (`drain` starts nothing), the **boot grace** (kind `boot`, `domains/capacity/boot.ts`: while the host's uptime, from `kern.boottime`, is under 30 min,
  no new lead until the five newest minute samples, all taken since the boot, show a load under a quarter of the ceiling and the newest
  sample's memory is under 80 % in use, then at most one lead per 2 min; resumed leads count against the seats as always; the reason reads
  "host booted N min ago: …"; an unreadable uptime applies no grace and says so as a note), the host's 1-minute load, its memory (swapouts and swap against ceilings; the swapouts are the higher of the pass's own rate and the minute samples' last 300 s, `sustainedSwapoutMb`, so a lull between bursts does not open the gate; the memory that a
  lane's `memory` reserves for its running leads and the candidate counts as swap in use, `docs/plan.md` "Lanes"; then the
  learned fit: a repo with at least three sampled attempts is refused, kind `memory`, when its p80 lead does not fit into
  the free memory of the newest host sample (not older than 5 min) less headroom (the larger of 2 GiB and 8 % of RAM); the running leads' test peaks are not reserved here, the slot grant holds them back (`SlotFit`); it
  replaces the lanes' `memory` for that repo's leads, never refuses with an unknown figure and never the only lead on the host), the
  candidate's lane (`lanes: {apple: 1}` in `project.yaml` caps the leads of a resource class inside the repo, a fix is
  never held; `domains/capacity/lanes.ts`), the repo's claims (`leads: N` plus one for a fix; `pace` allows one), then an
  account with room. **Seats:** when work is queued for the account cap and each of the newest five minute samples shows a load
  of at most a quarter of the ceiling and swap below its ceiling, the pass raises `leadsPerAccount` by the leads that fit into the
  free memory (`domains/capacity/seats.ts`, at most `FACTORY_SEATS_MAX_BONUS`, default 2, 0 is off); never the repo's `leads: N`, never
  past an account's window, and the `cap` reason says `(raised by N: the host is idle)`. The first that says no names itself and its numbers as the queue reason. It never spills to another
  account past a window or a cap; with every account closed it waits for the first opening. Owed Issues are served
  before new ones, in the repo and on the account: a woken lead is the same session on the account it was admitted on, so the
  account cap never refuses its resume (only the repo's claims and its lane do), and from the moment its wait ends it counts in
  its account's leads, so a new lead cannot take the seat it will run on. A lead in a wait that gave its claim up is idle and
  counts nowhere. A herd woken at once (a red master closing and waking a dozen deferred leads) takes the repo's places in
  order of its waits, oldest first, up to `leads: N`; the steward counts a refusal for a claim as a stall only when a claim
  would be granted to that lead now, and names the account it resumes on. The gates (windows, lead cap, loaded) stay the factory's; only the order among the accounts that pass
  them comes from the picker, `claude-account rank --lane bulk --json`, polled with the usage readings and stored in
  `capacity_ranks`. A missing or stale rank (older than a reading may be) falls back to the lowest weekly use and shows
  as the health line `account-rank`; it never blocks admission.
- **A turn that ends on an API error** (`domains/leads/apierror.ts`, `app/leads-api-errors.ts`, a step of the leads tick). Claude Code
  fires `StopFailure`, never `Stop`, when a turn ends on an API error (hooks reference, "StopFailure": `error`, `error_details`,
  `last_assistant_message`), so the session looks mid-turn to anything that waits for a `Stop`. The hook (every `error` type now,
  no matcher) spools it as `api_error` (a `rate_limit` stays the `limit_stop` wall); a session whose hook did not run is found
  by its transcript: a turn open and silent for `FACTORY_API_DETECT_MS` has the end of its transcript read (`TranscriptTails`,
  the last `assistant`/`user` record with `isApiErrorMessage`, its `error` and `apiErrorStatus`) at most every
  `FACTORY_API_PROBE_MS`, and the same fact is stored. `deriveSession` reads an `api_error` as the end of the turn
  (`SessionView.apiIncident`: the errors since the last clean `turn_ended`), so a note waiting for the turn to end is delivered.
  `kindOfApiError` reads the fields before the words: a 401 or an expired or revoked token is **auth**; a 429, 5xx, a
  timeout or reset, `server_error` (also mid-response, which adds "your last response may be cut off, re-check what you did" to
  the note) and a 403 typed `authentication_failed` (a Cloudflare challenge: 10 of 10 on 2026-11-13, none needed a login, though
  Claude Code prints "Please run /login") are **transient**; anything else is left to the steward. Transient: one `continue`
  (a `resume` delivery, key `resume:<session>:<incident>:<n>`) after 1 minute, then 3, 10, 10, 10, five at most per incident; three
  or more leads failing within five minutes are one **edge incident**: one clock, one `continue` per `FACTORY_API_STAGGER_MS`
  (30 s) among them, and one `api_edge_incidents` row (leads, window, and the owner's `plan-*` sessions in the same state,
  counted and never resumed) that the friction read shows as `api_transient` (informational, never a finding). Auth: the
  account gets an `account_auth_marks` row that capacity reads as "not signed in" (no admissions on it, nothing moved), and
  one Errand "log in account X" (request key `account-login:<account>`, no check: the picker still says the login is fine); its
  closing clears the mark and the account's leads are resumed like a transient error. The screen is read before anything is typed
  (`HcTerminals.resume`, and `type` for a note): herdr-core calls this state `blocked` or `error` and refuses a send, so the
  API-error line above an empty prompt is what permits the core's `force`, a draft in the box is submitted and not appended to,
  and any other screen (a dialog, a running turn) is left alone. The steward's idle nudge skips a session in an incident until
  its five resumes are spent. `api_blocked_minutes_per_day` (from the error to the next turn that started) is in the retro's
  capacity figures.
- **The quiet lead** (`nudgeIdle` in `app/loops/steward.ts`, `decideIdle` in `domains/loops/stall.ts`). A `working` Issue is
  no stall, so the steward reads each one's lead session (`deriveSession`: `idleSince` is the end of its last turn). A
  turn that ended with nothing reported since it began, in a live terminal, for `FACTORY_STEWARD_IDLE_MS` (10 minutes),
  gets a `noted` event by the steward that names the Issue's last event (a regression, a note) and tells the lead to
  check its background tasks and report. A session mid-turn, whatever a tool in it is doing, is never read. A turn that
  ended with background work in flight (a subagent, a check, a shell: the Stop hook lists it and `turn_ended` carries
  `backgroundTasks`, `SessionView.backgroundTasks`) is waiting, not quiet: it is nudged only after
  `FACTORY_STEWARD_IDLE_BACKGROUND_MS` (90 minutes, past the longest implementer wait measured), as a frozen task, and
  self-watch's `lead_idle` uses the same two thresholds. Work the Stop hook did not list counts the same, read live (`countLiveWork`, once the lead has been quiet
  past the plain threshold, for the steward and self-watch alike): a test slot held or queued by a command started in the lead's worktree (`capacity_slots.cwd`,
  `slotLiveIn`), or a queued or in-progress CI run of its branch (`CiLive`, `githubCiLive`; an unreadable source is not
  live). When that work ends the plain threshold applies again. The wakes are counted from the events alone (steward notes that
  begin with `IDLE_NOTE`), `maxWakes` per attempt and each after another threshold of quiet; after that `factory-steward` is
  asked, and its answer can only be one more such note: a quiet lead is never stalled or turned into a Decision (the options
  of one, pause, drop, a fresh lead, are applied by nothing); self-watch files it for the owner's side.
  The idle clock starts at the later of the turn's end and the last news the lead heard (`readIdleHistory`: a verdict, an owner's
  or Judge's note, a Decision's answer, the end of a wait, an Errand done), and no idle nudge comes within
  `verdictGraceMs` (30 minutes) of a verdict: the lead is reading and answering it. After a `changes` verdict the Issue waits on the lead's revision
  (`PendingRevision`): the generic nudge is held back, and after `reviseAfterMs` (60 minutes) of quiet the lead gets one note that begins with
  `REVISE_NOTE` and names `factory artifact revise <id>`, keyed by the artifact and the verdict, so it is sent once.
- **Annotation dispositions.** A lead answers each of the owner's annotations with `factory artifact annotation-reply` (`POST
  /v1/artifacts/:id/annotations/:annotationId/reply`, a lead verb gated on the Issue's current attempt): `applied`, `deferred` (the note
  names the Issue or signal it filed) or `declined` (the note says why), stored on the annotation (`disposition`, `disposition_note`,
  `disposed_at`). `factory issue ship` is refused while an owner annotation on any of the Issue's Specs or Concepts has none, naming
  each. The Console shows the disposition under the comment; the retro's taste part carries it, and an annotation declined twice for the same reason is a
  candidate standing rule.
- **A repeated stall is not asked twice** (`repeatedStall` in `app/loops/steward.ts`, `decideStall`). A stall of the same
  cause as the one the steward's last Decision of this attempt answered, whose detail reads alike (`sameWords`: the share of
  words, digits dropped, at least `SAME_STALL`), with no `noted` by the owner or the orchestrator and no `reopened` since
  the answer, stays stalled and asks nothing: the lead blocking again on the same reason, or a re-ship of the same change
  against the same failing check, is one question with one answer. A note delivered while it waited, or a changed detail, is
  news and ends it as before.
- **A hold is a timed wait** (`kernel/hold.ts`). When the Judge answers a Decision the steward raised with an option
  that reads as a hold (its label begins with hold, wait, pause or defer), `answered` carries `hold`, a time, and the Issue
  waits for it as a `timer` wait instead of going back to its lead; the lead hears the Judge's note when the time comes. A
  repeated `blocked` stall whose Decision was answered so is held again (`decideStall` → `hold`: a `noted` and a steward
  `deferred` until a time) and raises no Decision. The first hold is one hour, each later hold of the attempt twice the last,
  at most twelve hours. An answer from the owner, the orchestrator, a policy or a default resumes the lead as before.
- **The claim deadlock** (`breakClaimDeadlocks` in `app/loops/steward.ts`). A working or watching Issue keeps its repo's
  claim; when it is after an Issue of the same repo that stays queued for lack of a claim, neither can move. The edge gets
  there by the owner (or the orchestrator on his behalf) naming it with `after` (`POST /planning/after`, which takes a
  working or watching Issue too; `POST /planning/unafter` removes stored edges again). Each steward pass takes the queue's `claim` refusals, reads the holders with an open
  planning edge to one of them (`read/loops.ts`), and defers each: a `noted` and a `deferred` event by the steward, the
  reason in the `deferred` payload (`why`). The dependency wait frees the claim and the blocker is admitted; when it
  closes, the wake (`wakeDependents`) sends the holder back and it is counted as owed, served before new leads. One that
  had shipped goes back to `watching` with a new watch (the old one ends). Only open planning edges are read, never free
  text: a lead or an in-session subagent that merely mentions another Issue is not detected, and a blocker queued for any
  other reason (load, memory, window, chain) or in another repo is left alone.
- **The timer wake** (`wakeTimers` in `app/planning-pass.ts`). Every planning pass wakes each timer wait whose `until`
  has passed, as `wakeDependents` does for dependency waits: a `woken` event by the factory, keyed by the wait's version,
  so a replayed pass wakes once and a wait overdue by days ends on the first pass.
- **A long wait is told** (`read/long-waits.ts`, read by `readNeeds`). A timed wait lasting `FACTORY_LONG_WAIT_MS` or more
  (default one hour, from the event that began it to its `until`) of an Issue that open Issues wait behind, directly or through
  others (unmet `planning_edges` and the `after` of dependency waits), is a Needs item of kind `long_wait`: the Issue, its
  until-time and the count held. A leaf is not listed. It is Needs only once its `until` has passed and the Issue is still
  asleep: a timer still running is information, and Flow shows the waiting Issue. It is derived from the stored waits on every
  read, so it ends with the wait (a wake, a close, a new deferral) and no state of its own exists.
- **A Replan** (`app/planning-replan.ts`, `factory.replans`). An ordinary `chore` Issue, `Replan: <project>`, whose lead reads
  the plan and the open and recently closed Issues and proposes changes as a Spec with Decisions raised first; its first
  note is `domains/planning/replan.ts` (facts, then the playbook), no model is called. The owner files it
  (`POST /planning/replan`, `factory planning replan <project> [--ask ...]`), and the planning pass files one for the
  project of each long wait (above) whose repo is a known project. One is open per project: a second call files nothing
  and returns the open one (an owner's ask is added to it as a note), and the stalled key (head Issue and wait start)
  makes a replayed pass, or the same wait after its Replan closed, a no-op. A failure of the step is an entry in the
  pass's `errors`. The lead applies an approved proposal with `factory issue replan` (`POST /v1/issues/:id/replan`, a lead
  verb; `applyReplan`): gated on the Issue being a Replan, the current attempt working it, its latest Spec revision
  approved (`looks_good`/`with_notes`) and every dependent or cancel target being an Issue of the Replan's project, then
  edges added and removed and Issues cancelled through `addAfter`, `removeAfter` and `cancelIssue` as the orchestrator
  (the avoidable-touch counts read the owner alone). `/planning/after|unafter` and `cancel` stay owner only: a lead never
  edits the chain except through an approved Spec.
- **Start** (`app/leads-start.ts`): claim and look, make the worktree (`factory/<issue>-<attempt>`), then the terminal,
  then record the lead started. The terminal is found by its `factory.key` label before one is made, so a replay after a
  crash attaches to the lead that runs. The prompt is the brief (`domains/leads/brief.ts`): standing orders that are
  byte-identical in every brief so the prompt cache serves them (they carry the HerdrCore constraint: no lead restarts, stops,
  updates or starts the core or reboots to prove a change), then the Issue as filed, its facts and its notes. Notes and
  API-error nudges typed into leads are paced for 10 min after a server start, one per 10 s (`app/type-pace.ts`, `FACTORY_TYPE_GAP_MS`, 0 is off), so a restart's
  backlog does not land at once.
- **Hooks.** `factory hook` appends to the spool, then posts to the unix socket (mode 0600) within 300 ms. The server
  replays the spool with idempotent keys. Session state is derived from the events when read, never stored.
- **Notes** (`app/leads-note.ts`) are typed into the lead's terminal once: the delivery key is claimed before the typing, a
  lead mid-turn is asked again until its turn ends, and a lead whose terminal is gone is the lead gone. Before the typing
  the lead takes its repo's claim back (`resumeClaim` through `claims.resume`): a wait that ended left it without one, and
  a full repo refuses so the outbox tries again later. Trust follows the stored actor: a `noted` whose actor is `owner`
  is typed as "a note from the owner" and binds the lead (the contract says so); the factory's, steward's and Judge's
  (and any record without an actor) stay "a note, as data". The brief lists the owner's earlier notes in their own section.
- **The stop rule** (`domains/leads/stop.ts`): a lead that stops with nothing reported is sent back once with one line
  (the hook exits 2); the second time the Issue stalls as `unreported`. A stop with background work still running is no
  stop.
- **Finalize** (`app/leads-finalize.ts`), once per attempt and in this order: the claim goes back, the terminals close,
  the transcripts are archived, the worktree and branch are removed when clean and its work is on origin's default
  (the worktree is found by the path it was made at, because a lead may detach HEAD or rename the branch; its HEAD and the
  branch must be on the base, or a shipped commit must be, which a squash leaves as the only trace). When the Issue is closed, the same step
  cleans every `factory/<issue>-*` branch, local and on origin (`adapters/git/branches.ts`): a dropped or cancelled
  Issue's go, the others when their work is on origin's default (ancestry, an empty merge, a shipped commit, a merged
  pull request); the rest are kept and the reason is recorded with the worktree's.
- **Test slots** (`domains/capacity/slots.ts`): a host-wide semaphore around the whole `make check`, so parallel checks do not
  pile their load; `factory slot run` takes a slot, says once on stderr that it is queued for one (and how long it waited when
  it gets it), a wait past 45 minutes exits 75 without running, and a server that is down runs the command anyway. A command
  runs with `FACTORY_SLOT_ACTIVE=1`; a `slot run` inside one runs its command as it is, so the steps of `make check` do not queue
  again. The host's load in a scenario is the fake `sysctl`'s (`vm.loadavg`), never the machine's.
  Every step leaves a row in `factory.step_costs` (`POST /slots/:id/cost`: name, repo, peak resident size and CPU seconds of its
  process tree, duration, wait, exit code; the CLI measures with `ps` every 3 s and the renewals carry the size). The grant is
  `FACTORY_SLOTS` (default 2) as the base and `FACTORY_SLOTS_MAX` (default 6) as the cap: a lone step is always granted, a step
  below the base when it fits or its peak is unknown, one beyond the base only with a known peak, host load at most
  `FACTORY_SLOT_EXTRA_LOAD` (12) and a fit. It fits when its learned peak (the largest of its 8 newest) plus what the running steps
  still grow by (their learned peak less their size now) stays within the free memory of the newest host sample (not older than
  5 minutes) less a headroom of 2 GiB or 8 % of RAM; a waiter's `why` is shown in the CLI and the capacity view. No model is called.

## Quality

- **Ship** (`app/quality-ship.ts`, `domains/quality/gate.ts`): the lead names merged commits; git must find them on the
  default branch, read by the factory, never taken from the lead. Without that the ship is refused with the error named and
  counted as friction; so is the ship of an Issue flagged `checkpoint: spec` with no Spec submitted ("The Spec checkpoint", under Checkpoints). A review is recorded as evidence when agw's ledger covers the range, and its absence is recorded
  with its reason; it never refuses a ship (NL23). Whether a rebased, squash-merged change still counts as reviewed is
  agw's judgment (`covered`), not the factory's; `factory issue ship` prints one stderr line naming the range to `/review`
  when the answer is `uncovered`, or the reason when it was not read. The lead also states one line per acceptance line of the Issue
  (`--acceptance "met: ..."` or `"not met: ..."`; the factory parses no criteria), recorded as `acceptance` evidence and shown on the
  Issue page; a malformed line is refused (422), a `not met` never refuses, and a ship that states nothing is counted as
  friction (`unstated_acceptance`) like an unreviewed one. The pull request the commits landed through is read from GitHub
  (`adapters/quality/ci.ts`, the `Ci` port) and its head's CI recorded as `ci` evidence (`green`, `red`, `running`, `missing`
  when no pull request or no check was found, `unknown` when GitHub could not be read); it never refuses a ship, and a red
  or missing one is counted as friction (`unproven_ci`). A project that ships by push (no `via: pr` rule) or has no
  `project.yaml` records no `ci` evidence and asks GitHub nothing. `evidence.ts` decides whether the paths deploy at all; its built-in inert
  paths equal `scripts/verify.sh`'s. A project's `deploy.paths` (globs in `project.yaml`; empty by default, which changes nothing) narrows
  that further: with some declared, a path deploys only if a glob names it and it is not built-in inert, so a rewrite built beside the
  running system ships with `deploys: false` (no deploy, no version check). The gate, the watch's version check (`deployedHolds`) and
  `ProjectChecks.deployPaths` all read it; `scripts/verify.sh` stays the built-in floor.
- **Watch and verify** (`domains/quality/watch.ts`, `app/quality-watch.ts`): the project's `make verify` and probes run on
  their own loop, so a slow verify never holds the leads' pass. What the watch runs is the synced `project.yaml`
  (`app/quality-projects.ts`): deploy mode, `hold` as the window, `make verify` from a target, URL targets and probes. Only
  mode `make` reads `make version`; a missing version target there is red. A file with no target leaves verify to the
  Makefile, and a repo without a `project.yaml` is read from its Makefile alone (`adapters/quality/projects.ts`). A red check is retried with a doubling delay before it is
  a regression, unless it is a `make` target that failed the same way in the repo's last finished run before the ship, another Issue's watch (every failing line of this run, numbers aside, is among that run's failing lines, so a drift list that shrank or a changed number is the same red, a line the baseline never had (an added drift item too) is not; the Regressed note opens with the failed checks' names and first failing lines): that one is stored `inherited`, counts green, is never retried and stays on the Issue's page; a regression returns the Issue to its lead, twice, then it stalls. A checkout that cannot be read is
  rechecked, never passed. In a project that ships through a pull request (`ship:` `via: pr`) verify also reads the default
  branch's CI for the exact landed commit (`ci` check): green passes, red is red, and a run still running (or not yet visible
  within 10 min of the merge) is neither, so the watch is looked at again after `FACTORY_VERIFY_RECHECK_MS` and does not pass;
  one running past an hour is red, and no run at all after 10 min passes with that said (the repo may have none). A pending
  CI wins over a red `make verify` until it settles (`outcomeOf`: blocked first).
- **Reopen** (`app/quality-reopen.ts`) is the owner's, within 30 days of closing.

## Checkpoints

A Decision is a form with every field required (recommendation, what was checked, cost per option, what happens with no
answer). It is settled in order: standing policy (`FACTORY_CHECKPOINT_POLICY_FILE`), the Judge (`factory-ask`),
which reads the plan, the docs and the precedents of the ledger), the default after its wait when the option is reversible, then
the owner. A step is a claimed call with a 35-minute lease past the Judge's 30-minute hang guard. A form with a missing
field is refused (422 `missing_field`, the fields named, nothing stored). The Judge sees every Decision before the owner
does: a failed Judge call is tried again after a 5-minute backoff, three tries in all (`decision_steps.tries`), and while
tries are left the Decision is not the owner's (no owner step, no page, not in Needs). After the third failure it reaches
him with the failure in the Judge step's detail; `passed` and `rejected` stay final. The Judge's step is on the
`DecisionView` (`judge`) and its reason on the Needs item. A second ask from the same asker while the Issue still waits on
its open Decision amends that Decision: the form is replaced, the new rendering is the artifact's next revision (note
`amended`), the steps and unsent pages are cleared so it is settled afresh, and a verdict of a call that was out during
the amend is dropped (the form digest taken at claim no longer matches). The same form again is a replay; an answered or
withdrawn Decision is never amended. An Errand names what the lead tried (`tried`, a gate: not stored) and is refused at the raise, nothing raised
and the route named, when it asks for what the host does (`refuseHostClass`: a door token or route, an install, a sudo step with no
no-sudo attempt shown, a Report missing from Needs you); `call` on an ask or an Errand makes a repeat one event. Every refusal of the state
machine for a lead verb names the wait, how it ends and the verb to use (`waitHint`, `domains/work/table.ts`). An Errand passes a screen before it reaches the owner, in order: deterministic rules
(`screenByReview`, then `screenByRule`: a command a token can run and no hands word), then `factory-errand`, then the owner. The Issue waits from
the raise, but the owner is not paged and the Errand is not in Needs or the human queue until `errands.reached_owner_at`
is set. A turn-away ends the Issue's errand wait with `errand_done` (actor `factory` for a rule, `judge` for the workflow,
payload `turnedAway`: the reason), sets the Errand done with the reason as its note, and the lead hears it as its next turn.

**A pull request's review is not the owner's hands** (issue 1020). A pull request that waits on a required review by someone else
(the owner cannot approve one his own work account opened, and a review rule is never bypassed) puts the Issue in the `external`
wait, which a machine ends: the `reviews` loop reads each such pull request every 15 minutes through `gh` (pull requests) or `glab` (merge requests)
in the repo's checkout (`adapters/reviews/pr.ts`; a work repo uses `FACTORY_GH_CONFIG_DIR_WORK` for its account) and wakes the lead on an approval, a request for changes, a
review or comment by someone other than the author after the first look (`review_looks` keeps that baseline per wait), a merge or a close. A
lead enters the wait itself with `factory issue defer --review <url|#n>`; an Errand whose text asks the owner to approve or merge a named
pull request or bypass its review rule is turned away by `screenByReview` before any model is asked, and the same `errand_done`
(`awaits`) moves the Issue from the Errand wait to the `external` wait, so the lead hears the turn-away and what the reviewer did in one note. The wait
frees the repo's claim, is never in Needs you, and the Issue's read says it waits on someone else's review. The `glab` reads are
best-effort: its approvals appear only where `glab mr view -F json` carries `approved_by`.

**Turn back** (`POST /v1/errands/:id/turn-back`, `factory errand turn-back <id> --note ...`, the Console's Turn back button; owner and
orchestrator). The Errand is not done: `errand_turned_back` ends the Issue's errand wait, the lead hears the note, and the Errand
closes `turned_back` by `owner` or `orchestrator`. It is the one way the orchestrator ends an Errand wait; `errand_done` stays the owner's.

**The desk pass** (`desk` loop, every 15 minutes it asks whether it is due; `app/loops/desk.ts`, `domains/checkpoints/desk.ts`). It is due
when the owner's `GET /v1/since` read comes two hours or more after his last one (`console_visit.returned_at`), when it never ran, and
in any case every 6 hours. One pass over every open Errand, an Issue's and a request: each `check` runs (30 a pass) and an Errand whose check exits 1..125 closes
`not_needed` by `check`, telling its lead with `errand_done` (`resolved`); the rest that reached the owner are screened again (`rescreenErrand`: the same
rules and `factory-errand`, 10 a pass) and an Errand an agent can do now is turned away as at the first screen; then one MacBook
command Errand (a request with a command and host `macbook`, never pushed first, else pushed longest ago, none within 6 hours) is pushed through `ask-human.sh push`
(`adapters/shell/ask-human.ts`, `FACTORY_ASK_HUMAN_BIN` or the dotfiles' copy), whose dialog answer closes the Errand on its own. A lead's `errand raise --check <cmd>`
stores the check on its Errand, so anything a machine can observe closes itself.

**A request is an Errand no Issue raised** (`app/checkpoints.ts` `requestErrand`, `domains/checkpoints/request.ts`, `POST /v1/errands/requests`,
`factory errand request`; callers owner, orchestrator and agent). `errands.issue_id` is null, there is no `errand_raised`
event, no lead and no page: it reaches the owner at intake (`reached_owner_at = raised_at`; an owner already told
by the asker's own dialog needs no second push), except a request from a screened source (`SCREENED_SOURCES`: `ask-human`),
which waits for the Errand screen like a lead's Errand (the rules, then `factory-errand` with the command added to the detail and
the asker as the repo). A turn-away closes it `turned_away` with the reason as its note (there is no lead to tell); a pass puts it
in Needs without a page. Why not an Issue that holds it: an Issue per request files work no lead can do,
`errand_done` would wake it, and the work table has no "waiting on an Errand, no lead" cell. It carries `source`, `command`, `host`
(`macbook|iphone|portal|any`, from the asker or read from the words, `kernel/hands.ts`), `check_command`, `expires_at` (7 days
when it has no check and none was given; `never` and a check keep it) and `request_key`: a new request with the key of an open
one closes it as `superseded` in the same transaction (the same words again are a replay; asked again after it closed is a new
Errand). `closed_kind` and `closed_by` say how any Errand ended (`done`, `not_needed`, `expired`, `superseded`, `turned_away`;
by `owner`, `check`, `judge`, `loop`, `request`); the owner closes one as `not_needed` with `outcome` on `POST /v1/errands/:id/done`
(the Console's existing verb, no ninth one), and a lead's Errand closed that way tells its lead so. The `check` is a shell command
the server runs, so only the callers that can run a shell may set one (`api/policy.ts`); it runs through `sh -c` in its own process
group, 30 s, the server's secrets left out of its environment (`adapters/shell/check-runner.ts`); wherever the factory quotes output it
keeps the first 20 lines and the last 20 (`kernel/run.ts`), because the reason is at the top.
**A done is not always done** (`finishErrand`, `POST /v1/errands/:id/done`). A result that says the pushed run failed (`run.status`
`failed`, `timeout` or `running`, or a non-zero `run.exit`; the words `ask-human.sh` wrote before it sent `run`, `ran on the MacBook
and failed (exit N)`, count too) leaves the Errand open and records the run (`run_*` columns: tries, status, exit, head, tail); Needs
shows `tried, failed: <first error line>` (`tried`) and the Console its output. A done on an Errand with a `check` runs the check at
once, outside any transaction: exit 0 reopens it with `check_note` `marked done but the check says still needed` (the hourly pass
keeps that note), exit 1..125 closes it with the check's output in the note, a check that could not answer closes it as before.
A failed or refused call is tried again after the Judge's 5-minute backoff, three tries in all (`errands.screen_tries`);
after the third the Errand reaches the owner unscreened (`screen_by` `failed`).

**The recheck.** A Decision or Errand that has been in front of the owner longer than `FACTORY_CHECKPOINT_RECHECK_MS`
(6 h; 0 is off) is looked at once more, by `recheckOpen` (`app/checkpoints-recheck.ts`), which the `settle` loop and
`checkpoint pass` run before the settle steps and the screen, so the second look owns the reason for anything past the
threshold. A Decision is at the owner when its `owner` step is `open`, an Errand when `reached_owner_at` is set. It is
due when the threshold has passed since it reached him or was last looked at, and the Issue has an applied event beyond
the version the last look saw (for the first look, the version when it reached him, read from the log's times), so
nothing is checked twice without news. Deterministic first: an Issue that is closed, or no longer waits for it, withdraws
the Decision or finishes the Errand with the reason (`withdrawalReason`, which also names a newer Decision on the same
question; a checkpoint the Issue still waits for is never withdrawn). Otherwise the Judge looks again with the Issue's
events since it was raised (`factory-ask` for a Decision, `factory-errand` for an Errand): an `answer` that passes
`guardVerdict`, or a turn-away, settles it through the usual paths (`answerIn` and its note, `turnAway`), so the lead
hears it and the owner can overrule it with a note. The events travel inside fields the workflows already read, because an
unknown field is dropped: appended to `checked` for the Judge, to `detail` for the screen, scrubbed, as data. Every look
is a row in `checkpoint_rechecks` (`outcome` `withdrawn`, `settled` or `kept`; `by` `factory` or `judge`; `reason`;
`through_version`; at most one per checkpoint and version) and one `rechecked` change on the stream (kind `decision`, `errand` or `artifact`, detail the id and the outcome), which the "Since you were here" band reads. A failed call is recorded as
`kept`, so a dead Judge is not asked again every tick. Call keys: `factory-ask:recheck:<decision>:<version>` and
`factory-errand:recheck:<errand>:<version>`.

A Concept or Spec is a
revisable artifact; the owner's verdict arrives as the lead's next turn. Revisions are blobs under the data directory
named by their hash, never in git. The owner's line (ntfy) carries one page per checkpoint, plus one push for a Concept or Spec revision nobody answered in a day, and nothing else.

The Console shows an artifact at `/artifacts/<id>` (`?revision=n`, `&compare=m` for two revisions side by side) as a
designed page: a header band (a link back to its Issue with the Issue's state and project, the title, the kind and format in
words, a revision selector, and for a Concept or Spec the verdict control, a button whose popover holds the four words and
a note), the document centred in the column left of the comments panel (prose capped at 75ch), and the panel: one card per
comment (author, time, the quoted passage, the words, where in the document), with "General" (a comment on the whole
artifact hangs on the title with the path `global`) and "Unanchored" as their own groups when more than one group exists,
and a box for a general comment at its foot. A card is a button: it brings its passage into view and paints it stronger
(`annotation-active`; `factory.scroll` and `factory.deactivate` in the HTML frame) and shows edit (the owner's own) and
delete in place. The owner marks text and comments on it; selecting a passage opens the comment box as a popover anchored
under it (`popoverPosition`, flipped above when there is no room, following the passage through scroll; a bottom sheet below
`lg`); the page posts the quote (the selection with its whitespace
folded, which is what the API anchors on) and the nearest heading path, and highlights the anchored comments with the CSS
Custom Highlight API. Markdown renders through react-markdown without raw HTML, with unsafe URLs refused and no image
loaded; HTML renders in an `<iframe sandbox="allow-scripts" src="/frame.html">`: a separate document the Console listener serves
under its own CSP (no request can leave it, and unlike a `srcdoc` frame it does not inherit the page's policy, which keeps
`script-src 'self'`). The page sends the artifact to the frame by `postMessage`; the injected annotator posts selections
back, and the page believes only its own frame's well-formed messages. Templates for a lead are in `apps/console/templates/`.

**The Spec checkpoint** (issue 725). The owner wants few asks and the essential ones: an architecture or look-and-feel choice that
later Issues build on, a new public surface, a data model or migration of meaning, a dependency of weight, a UI screen he has
not seen. Those are a one-page Spec, never a Decision (order 2 and 3 of the standing orders, `domains/leads/brief.ts`; the
brief test pins the wording). Three parts:

- *The flag.* `checkpoint: spec` on a plan row, `factory issue new --checkpoint spec` or the `filed` event (`filed.checkpoint`,
  kept on the Issue as `checkpoint`; old events carry none). The filer sets it, and so may triage: a settle answer's optional
  `checkpoint: spec` (new public surface, data model, dependency of weight, unseen screen) rides the `settled` event
  (`settled.checkpoint`) onto the Issue, for any Issue triage was asked about but an incident. The triage pass counts them as
  `flagged`; Improve's specs per 100 Issues is the measure. The workflow side (agent-workflows `factory-triage`) must learn the
  field; until it does the answer carries none and nothing is flagged. The brief of a flagged Issue carries a "Checkpoint"
  section.
- *The gate.* `shipIssue` refuses a flagged Issue's ship until a Spec exists for it (any attempt; a Concept does not count),
  before any git read, as a refused ship on the record (so `refusals` counts it) with `SPEC_OWED` as the verb's error.
- *The timeout.* A Concept or Spec the owner has not answered for 24 hours is looked at once per revision by
  `recheckReviews` (`app/checkpoints-reviews.ts`, run by `settle` and `checkpoint pass` after `recheckOpen`; no model, no port):
  its Issue closed or no longer waiting: withdrawn (verdict `no_longer_applies` by the factory, pages cancelled); anything
  else, Concept or Spec, flagged Issue or not: **defaulted** (verdict `looks_good` by the factory with a note, `verdict_given`
  and `noted` by actor `factory`, so the lead hears "no verdict, go on with your defaults" once and the owner can still
  overrule with a note). Nothing stays in Needs you past the wait: there is no second push, because it would fall on the same
  hour as the default. A Report never waits on the owner. Each look is a `checkpoint_rechecks` row of kind `artifact`
  (`through_version` is the revision seen, so a revision is looked at once). `SPEC_WAIT_HOURS` (contract, `lane.ts`) is the
  one number; the brief and the gate's message quote it.
- *A Decision is a choice.* `askDecision` refuses a lead's Decision whose recommendation or default is to keep waiting
  (`refuseNoOpDefault`, `domains/checkpoints/decision.ts`: "Keep waiting", "Wait for review", "Do nothing", "Hold") with
  422 `invalid_request` naming `factory errand raise`: what it waits for is a person's chore (approve a PR, rotate a key,
  click in a UI), and a chore is an Errand. The steward's asks are exempt: a hold is a real answer to a stall. Order 2 of the
  brief says the same.
- *Taste.* The owner's verdict notes and annotations are the one signal of what he likes. `factory retro` carries them as
  `taste` (`read/retro-taste.ts`: his own verdicts with a note or a `with_notes`/`changes`, never the factory's defaults, and
  his annotations, each with artifact, repo and Issue; words dropped for the read token), and `verdict_changes_share` (his
  `with_notes` and `changes` over all his verdicts of the window, lower is better) is a KPI. Part 2d of the retro text
  (`domains/loops/retro.ts`) groups them into recurring preferences and files a signal per preference seen twice or more, to
  write it into the repo's `AGENTS.md`, `apps/console/DESIGN.md` or the lead brief, with that KPI as the marker.

*A Spec that comes with the Issue* (issue 911). A filer that already wrote the Spec (`factory issue new --spec @file`, body
`spec` and `specTitle`) hands it over at filing: `fileNewIssue` stores it in the filing transaction as an artifact of the
new Issue (kind `spec`, revision 1, author `factory`, key `filed-spec:<issue>`, which is the only mark that tells it from a
lead's Spec) and plans the owner's review page; `spec` implies `checkpoint: spec`. No wait begins (the machine's waits start
from `working`): the Issue settles and queues as any Issue, and `orderQueue` gives it the queue reason `spec` while the
latest revision of that Spec has no verdict (`OpenIssue.specPending`, read in `read/planning.ts`; a held incident stops no line). A
verdict on it (the owner's, or the factory's `looks_good` after 24 hours: `recheckReviews` also looks at a filed Spec whose
Issue is settling or queued) records only its note (`giveVerdict`, `noted`), since there is no wait to end; the Issue is
then admitted and the lead's brief has a Checkpoint section naming the artifact and its verdict instead of the order to
submit one. The ship gate counts it like any Spec. A lead that finds it wrong revises it (`artifact revise`).

Improve counts `specs_per_100` and `owner_decisions_per_100` (trend only), so a silent path shows as two near-zero lines.

## Loops and agw

A loop is a named tick (`app/loops/runner.ts`) with a trigger (an interval, or a kick when something changed), a budget
and single-flight passes. Its deterministic part runs in the server; its judgment is a dedicated agw workflow with its
own prompt, tools and skills (`agent-workflows`), called through the agw port with a 30-minute hang guard. A call is
recorded in `loop_calls` under its key, so the next boot takes it up again. The clock runs from the loop's last pass, not from
boot (`loop_passes`, written at the end of every pass): the first pass after a restart comes when the interval since the
last one is up, at once if it never ran, so a 6-hour loop still passes on a server that restarts on every deploy.

| Loop | Deterministic | agw workflow |
|-|-|-|
| `leads` | spool replay, start, notes, finalize, the outbox | none |
| `planning` | read projects, file plan rows (`docs/plan.md`) whose `after` rows closed, mark the chain, wake dependency waits and timer waits whose time has come, file a Replan for a project whose chain head is in a long wait (one open per project) | none |
| `watch` | verify and probes | none |
| `settle`, `send` | rechecks of checkpoints at the owner past `FACTORY_CHECKPOINT_RECHECK_MS`, Decision steps, unscreened Errands, pages | `factory-ask` (the Judge); `factory-errand` (the Errand screen): stdin `ErrandScreenRequest` `{ errand: { id, summary, detail\|null }, issue: { id, repo, title, kind } }` labelled untrusted data; stdout `ErrandScreenAnswer` `{ verdict: pass\|turn_away, reason (1..300) }`; call key `factory-errand:<errand>:<try>` |
| `steward` | wake, re-check, requeue, deliver (`domains/loops/stall.ts`), nudge a quiet lead, note a watch whose checkout stays blocked, break a claim deadlock; while a project has a live lead, read its main checkout once a pass from local refs (`domains/loops/checkout.ts`): off the default branch or with tracked uncommitted changes, it is a `main-checkout` health line and, when its branch is a live lead's (`factory/<n>-<attempt>`), one note to that lead (once per branch state and clean/dirty); a branch no lead owns names no session and reaches no lead, no model | `factory-steward`: what a stalled Issue needs when the rules do not say |
| `triage` | fingerprint, routes, correlation window | `factory-triage`: kind, amend-or-new-or-already-settled (open and last-day closed Issues), likely `after` edges, `checkpoint: spec` for a change that needs a Spec first |
| `queue` | per repo: cycles in the chain, the queued Issues that wait for nothing (an ask needs two), the queue's shape (asked once per shape; an edge the loop added is part of it), a budget (one ask per repo per `FACTORY_QUEUE_GAP_MS`, three repos a pass), the edges checked and added through planning (never against the owner's `prio`) | `factory-queue`: `after` edges and a tie-break order; the order is recorded in `queue_asks`, never applied |
| `friction` | the week's counts (`read/friction.ts`), cut at the newest import (`import_issues.imported_at`: the old core's history is never counted), against the rules in `domains/loops/friction.ts`: a rate per Issue closed with a minimum sample of 10 closed, or a bare count for the serious patterns (stall, lead lost, undelivered note, regression); retired mechanisms (the review gate, NL23) are skipped. One signal per pattern over its rule, 5 at most, filed on this repo through intake with the evidence Issues; a pattern whose Issue is open amends it with a note (intake's fingerprint). Due once a week, read from `friction_passes`; the same pass files the weekly retro signal (`domains/loops/retro.ts`: one Issue on this repo whose lead reads `factory retro --days 7`, writes a Report and files one signal per change with a `Retro:` marker line that the next retro's ledger reads), a failure to file it only named in the pass line | none |
| `hygiene` | one project a tick (those with a `project.yaml`; `FACTORY_HYGIENE_REPOS` narrows): a throwaway checkout of the default branch swept by the probes (`check`, `links`, `retired`, `deps`, `cochange`, `adapters/hygiene/`), due again after `FACTORY_HYGIENE_EVERY_MS` (a week), read from `hygiene_passes`; at most 5 signals a project and pass, probe findings ranked in probe order and limited to 3, the rest named in `over_budget`; filed through intake as the project's own agent; a project whose `make check` needs a lab this host lacks says `hygiene: { check: false, reason: … }` in `project.yaml` and the `check` probe is skipped, the reason in its run detail | `factory-hygiene`: the stale and recently edited documents read against the code, at most the budget left (2 at least); its title is built from the kind and the path, so the same document is one pattern for intake; a failed ask is retried at the stored commit every `FACTORY_HYGIENE_RETRY_MS`, 3 attempts at most |
| `selfwatch` | every `FACTORY_LOOP_SELFWATCH_MS` (5 min), six deterministic conditions of the factory itself on this repo (`domains/loops/selfwatch.ts`): `ci_red` (the two newest completed runs of a workflow on the default branch, or `FACTORY_SELFWATCH_BRANCH`, both failed; skipped and cancelled runs do not count; needs `FACTORY_GITHUB_TOKEN`), `migration_clash` (one number on two file names across origin/master and every local and remote branch except a closed Issue's lead branch, bar `SHARED_NUMBERS`; past 200 refs a pass the rest are named in a `refs-unchecked` finding of the same kind), `wait_overdue` (a `timer` wait past its `until`, a `dependency` wait whose Issues all closed, each plus `FACTORY_SELFWATCH_GRACE_MS`, 10 min), `lead_idle` (a working lead quiet past the steward's `idleLeadMs`), `inert_regression` (a `regressed` wait whose attempt's stored ship has `deploys` false and only inert paths), `heartbeat_stale` (`GET /health`'s heartbeat not ok: no successful leads tick for 20 min, or a database error the health probe has held for 5 min; a database-class miss is also read again twice, 5 s apart, as a second guard). Filed through intake as the repo's own agent, 5 a pass at most. A subject is one row in `selfwatch_findings`: filed once; the same evidence files nothing; changed evidence is filed again under the same title, which intake turns into a note on the open Issue; a subject that no longer holds is cleared and files anew if it returns. The title carries the subject in words (intake's fingerprint drops digits); a source that cannot be read (no token, no origin/master) names itself in the pass summary and leaves its open rows alone. Turning on `signals.github.checks` in `project.yaml` is the intake's own first-red signal; `ci_red` is the two-in-a-row one | none |
| `screen` | up to 10 held signals not yet screened (oldest first, `intake_signals.screened_at` null, `screen_attempts` under 5, `screen_retry_at` due), one call each, outside any transaction; the answer is checked before anything is done (`domains/intake/screen.ts`): a promote needs a known non-work repo (the signal's own, else the one named), a duplicate must be an open Issue of the repo it was shown, else the verdict becomes `leave` with a note; then `promote` or `dismiss` as `judge` (each looks at the state again: an owner who acted first is counted, not an error). A failed, unparseable or timed-out call (a missing workflow too) leaves the signal held and records the attempt with a backoff of `min(10 min * 2^n, 6 h)`; the pass still ends ok and its summary says `screen workflow unavailable` when every call failed | `factory-screen`: stdin `ScreenRequest` `{ signal: { id, source, kind, origin, repo, title, text, link, receivedAt }, openIssues: [{ id, title, kind, state }] (open Issues of `signal.repo`, at most 40, empty with no repo), projects: [name] (known projects that are not work repos) }` with title and text scrubbed and labelled untrusted data; stdout `ScreenAnswer` `{ verdict: promote\|dismiss\|leave, reason (1..300), repo\|null, duplicateOf\|null, recommendation (<=300)\|null }`; call key `screen:<signal>:<attempt>`. A held signal 72 h old (`FINAL_SCREEN_MS`) that was not screened since it got that old is on its **last look**: `final: true` in the request, failed calls not capped, and a `leave` is replaced by the factory (`decideFinal`): promote when the signal's repo is a known non-work project (the new Issue carries a `noted` steer: investigate, draft the reply, post nothing, raise the draft as an Errand), else dismiss with the reason. It leaves Needs you either way |
| `errands` | every hour (`FACTORY_LOOP_ERRANDS_MS`; off with the tick), over the open requests (Errands with no Issue), oldest first, outside any transaction (`app/loops/errands.ts`): past `expires_at` closes `expired`; with a `check`, up to 20 a pass, exit 0 keeps it (`check_note`), exit 1..125 closes it `not_needed` by `check` with the output, and a check that could not answer (126, 127, 128 and up, a timeout, no start) keeps it open and is noted, named in the pass on the third run in a row; with no check, from 24 h old and again every 24 h (5 a pass), the still-needed look reads the request and the same source's other requests of the last 14 days (how each ended, scrubbed, cut) and only `not_needed` with a reason closes it by `judge`; a failed look is made again after 6 h. Every closure not by the owner is listed once in the `errands` category ("Errands closed without you") of `GET /v1/since`. A request the owner closed while a check ran stays his | `factory-errand-needed`: stdin `ErrandNeededRequest` `{ errand: { id, source, summary, detail\|null, command\|null, host, raisedAt, ageHours }, evidence }` labelled untrusted data; stdout `ErrandNeededAnswer` `{ verdict: needed\|not_needed\|unsure, reason (1..300) }`; call key `factory-errand-needed:<errand>:<day>`; a missing workflow fails the call, keeps the request and is named in the pass |
| `reviews` | every 15 min (`REVIEW_POLL_MS`, `FACTORY_LOOP_REVIEWS_MS`; off with the tick), over the Issues in an `external` wait, outside any transaction (`app/loops/reviews.ts`): `gh pr view` / `glab mr view` in the repo's checkout; an approval, a request for changes, a review or comment by someone else after the first look, a merge or a close wakes the lead with `woken` (key `woken:<issue>:external:<since>`); a read that fails changes nothing and is named in the pass | none (`gh`, `glab`) |
| `desk` | asks every 15 min (`FACTORY_LOOP_DESK_MS`; off with the tick) whether the desk pass is due (the owner back after 2 h, or 6 h since the last), then runs it (`app/loops/desk.ts`): checks, a second screen, one MacBook command pushed through `ask-human.sh push` (a hang guard of 30 min on the script) | `factory-errand` on the second screen |
| `fix-classes` | every 6 hours (`FACTORY_LOOP_FIX_CLASSES_MS`; `FACTORY_HYGIENE_REPOS` narrows, repos checked as for hygiene): per project (those with a `project.yaml`), `git log --no-merges` on origin's default branch since 35 days (`adapters/hygiene/fix-commits.ts`), the commits whose subject is a conventional `fix`, those not in `fix_commits` yet sorted by the rules of `domains/loops/fix-classes.ts` (scope `test`/`docs`/`ci` and the like, a subject naming a review) and stored `by: rule`; the rest in batches of 40 to the workflow, stored `by: workflow` only when the answer has exactly one known class per sha, else the whole batch waits for the next pass (a failed call never invents a class) | `factory-fix-classes`: stdin `FixClassesRequest` `{ repo, classes, commits: [{ sha, subject, scope, body, files }] }`, answer `{ answers: [{ sha, class, reason }] }`; the key is the repo, the sorted shas and the day. The classes are `FIX_CLASSES` (`docs/product.md` "Fix classes"). Read on Improve ("Fix commits by class", the last four weeks) and in `GET /v1/fix-commits` (`factory read fix-commits`) |
| `host` | every minute (`FACTORY_LOOP_HOST_MS`): one reading of the host (load, memory as the kernel's app (`vm.page_pageable_internal_count` minus purgeable), wired and compressor pages over RAM, as Activity Monitor's Memory Used (`sysctl` and `vm_stat`; summed process RSS counts shared pages many times), swap use and swapout rate through the capacity reader), stored in `host_samples` with the capacity facts of that minute (`leads` = claims held, `queued`, `seats` = enabled accounts x `FACTORY_LEADS_PER_ACCOUNT`, `load_ceiling`; null when unreadable), rows older than 25 h dropped in the same pass. The same pass costs every lead: the one `ps` (`pid,ppid,pcpu,rss,comm`) and one `lsof -nP -a -d cwd -Fpn` (`FACTORY_LSOF_BIN`, 10 s) give each process's directory, `domains/capacity/leadcost.ts` assigns a process to the attempt worktree (live, or ended in the last 10 min) with the longest path containing its directory and adds all its descendants (a pid counted once), one `top -l 1 -n 5000 -stats pid,mem` (`FACTORY_TOP_BIN`, cached 10 s with the `ps` rows; its MEM column is the kernel's `phys_footprint`, shared clean pages left out, at 0.4 s for the whole host where `footprint -p` costs about 12 ms per pid) gives each process's physical footprint, summed per tree beside RSS (a process `top` did not list counts at its RSS; a failed `top` leaves the footprint null and the row RSS-only), and one transaction stores a `lead_samples` row per worktree (rss MiB, footprint MiB, process count; kept 30 days). Admission still learns from `rss_mib`; the footprint is recorded to be calibrated against it first. A failed `ps` or `lsof` records the host sample without lead rows and the summary says so. `read/lead-costs.ts` answers per repo the attempts, the p80 of the newest ten attempts' peaks and the newest peak, and the same two figures from the footprint (over the newest ten attempts that have one) with the median footprint-to-RSS ratio (`factory read capacity-loop`, `leadCosts`). `GET /v1/host` (`factory read host`) answers the last 24 h with the top 8 processes by cpu and memory (one `ps`, cached 10 s) and the server's version and start time; a reading that failed is null | none |
| `digest` | every 3 h (`DIGEST_TICK_MS`, `FACTORY_LOOP_DIGEST_MS`; off with the tick): for each project with a `project.yaml` (`source = 'file'`, work repos included; worktrees and a second directory of a name are the one project, `kernel/digest-scope.ts`) that has an Issue open or closed in the last 7 days, builds the request of `agw factory digest` (closed Issues of the window with outcome, working and watching, settling and queued with their open `after` edges, waiting with the wait reason, the previous headline; `domains/loops/digest.ts`), and skips the call when the hash of that input (without the window and the previous headline) equals the newest stored one. One call per project and pass, outside any transaction; the answer is checked against the ids sent and stored as a new row of `project_digests` (project, hash, route `factory.digest`, the digest). A failed call stores nothing, is named in the pass summary and asked again next pass, and never blocks another loop. `GET /v1/projects/digests` (`factory read project-digests`) answers the newest digest of each project with work in the window and its counts (done in 7 days, working, queued, waiting) read from the Issues now, never from the model; the read token gets the counts of a work project and no words (the work projects share one entry named `private`) | `factory digest` (the `FAST` route) |
| `reaper` | every `FACTORY_LOOP_REAPER_MS` (5 min), no model call: ends the processes of **closed** lead attempts (`domains/loops/reaper.ts`, `app/loops/reaper.ts`). Closed = the attempt's finalization is done (`lead_finalizations.done_at`: claim released, terminals closed, transcripts archived, worktree removed or kept), never merely `gone_at` while finalization could still need the worktree; an attempt with no such row counts as live. One `ps -Eww -Ao pid=,ppid=,etime=,command=` (`FACTORY_PS_BIN`; macOS `-E` appends the environment) and the `lsof` cwd map (`FACTORY_LSOF_BIN`), 10 s each, give every process its `FACTORY_SESSION` (the lead key `lead-<issue>-<attempt>` its terminal's `factory.key` label also carries; only that value is kept, never the command line) and directory; a failed `ps` or `lsof` fails the pass and ends nothing. A process is a leak when its session names an attempt closed longer than `FACTORY_REAPER_GRACE_MS` (5 min, at least 1) with no live twin, or its directory lies inside (path boundary) such an attempt's worktree and inside no live attempt's (a worktree the finalization kept, `lead_finalizations.worktree_path` set, is exempt from this path rule: the owner may work in it to rescue what it holds; its session rule stays); an unknown session or directory, pid 1, this server and its ancestors are never touched, so a browser reparented to launchd is found where a process-tree walk is not. SIGTERM first; a leak that survived an earlier SIGTERM (same pid, not younger than recorded: a reused pid is a new process) gets SIGKILL on a later pass; the pid's age is read again just before each signal. One transaction records a row per signal in `reaped_processes` (pid, session, worktree, program name, signal, reason, age; kept 30 days). `FACTORY_REAPER_DRY=1` records `dry` rows and sends nothing | none |

**Finding classes.** `friction` and `hygiene` hold a noisy kind of finding back. A class is the loop plus the finding's
first key segment (`judgment:<kind>` for a judgment): the probe, the kind of judgment, the pattern group, across all
repos: the noise is one probe misfiring everywhere, a few Issues per repo, so a per-repo class would never reach 3. The fact is
`factory.loop_findings` (which class filed which Issue); the state is derived from the Issues' outcomes
(`domains/loops/classes.ts`) and never stored. Of a class's ten newest decided Issues (done, healed, dropped or
cancelled), with at least 3 decided, a share of dropped or cancelled above one half **holds** it for 14 days after its last
Issue closed: it files nothing, and the held findings are named in the pass record's `overBudget`. After the hold it is on
**probation**: one Issue at a time across repos, none while another of its Issues is open in any repo, until one closes done, which forgives the
history before it. Held and probation classes show on Improve ("Held finding classes") and in `GET /v1/finding-classes`
(`factory read finding-classes`). Deviation: the owner asked for a rollup signal, and this is the section and the read
model, not a signal: an agent-trust signal files an Issue, and no loops page exists to carry it.

## API, client, CLI

- **Elysia** with zod through Standard Schema and `@elysiajs/openapi` for the document. Who may call a route is the one
  table in `api/policy.ts`; a walk of the OpenAPI document fails the tests on a route without a row.
- **The CLI is generated** from the OpenAPI document (`apps/cli/scripts/generate.ts`), one command per operation, keeping
  agw's contract: `--format json|plain`, data on stdout, messages on stderr, the exit codes, never a prompt. The hook, slot,
  deploy-lock, follow, retro (the retro bundle: `GET /v1/retro` plus `retro-transcripts.ts`, a pass over the lead transcripts for seconds by tool category, idle gaps, tool-error classes and `make check` runs, no model), role and issue schema verbs are hand-written where their contracts demand it. The CLI authenticates itself on the host: with no `FACTORY_TOKEN` and no `FACTORY_READ_TOKEN` it resolves the owner token from the deployed release's `.env.tpl` through `secrets-run` (`credentials.ts`; a set token wins, offline verbs and `health get` never resolve), so a session files with `factory issue new` and `factory signal file --from agent:<repo>` and needs no wrapper. Commands of the old CLI answer with
  the way to the same thing (`apps/cli/src/retired.ts`). A flag's help and the client-side validation of a body (bare Issue
  numbers normalised to `issue_<n>`, every violated limit named, exit 2, nothing sent) derive from the contract schema of the
  request body (`apps/cli/src/body-schema.ts`); `--schema` prints that body's JSON Schema.
- **Callers and tokens.** The caller is decided by the bearer token alone: `owner` (`FACTORY_TOKEN`, required), `orchestrator`
  (`FACTORY_ORCHESTRATOR_TOKEN`), `agent` (a lead), `machine` (the door), `signal` (Hermes) and `read`; every other token is
  optional, all differ, and a caller whose token is unset does not exist. The orchestrator, the owner's delegate agent, is on
  every owner row except the eight that are the owner's own judgment or hands (a Decision's worth-asking flag, an artifact's
  verdict and annotations with their edit and delete, an Errand done, a held signal's promote and dismiss). Its events carry the actor `orchestrator` and a Decision it answers is settled by
  `orchestrator`, so the owner-touch counts (`read/kpis.ts` `ownerTouch`) read the owner alone and its steering is the friction
  group `orchestrator_steer` (`steer:*`). A lead hears its note exactly as the owner's. Rows from before the token (the owner's
  actor with `via: orchestrator`) count as steering too.
- **One contract** in `packages/contract` builds every body; a body that does not parse is exit 9.
- **Reads** (`/v1/*`, `read/`): needs, flow, chain, Issues, sessions, signals, accounts, queue, loops, friction, finding classes, fix commits, kpis, retro (`GET /v1/retro`: the KPI table with history, the friction counts, the lead sessions with their transcript paths, samples of Issues worth reading and the ledger of earlier retro signals; the read token gets no path and no words), host, since (the Console's "since you were here" band: `read/since.ts` counts what the event log, Decisions, Errands, signals and incidents say after a start; only the owner's read moves the one-row `console_visit` marker, `app/visit.ts`: a read 30 minutes after the last starts a new visit at the old `seen_at`, the first looks back 24 h) and
  the change stream. Health lines (`read/lines.ts`) are kinds `door`, `account`, `account-rank`, `loop`, `checkout` (a blocked watch) and `main-checkout` (a shared main checkout off its branch or dirty under a live lead). The stream (`read/stream.ts`) resumes from an opaque cursor without losing or doubling a change.
  `GET /health` carries the heartbeat and answers from memory: a background probe (`read/health-probe.ts`, every
  `FACTORY_HEALTH_PROBE_MS`, 10 s, one read at a time) holds the database facts (`queueMovedAt`, the door lines, a database error),
  so a request never waits for Postgres and answers within a second at load 200. `ok` is false only for a stopped factory:
  no successful leads tick for 20 min (`TICK_DEAD_MS`; `FACTORY_HEARTBEAT_STALE_MS` replaces it for a scenario), no first tick
  5 min after a start on a host that is not starved (a load of twice the CPU count or more keeps `starved: no tick has succeeded yet` ok until the 20 min), or a database that errors for 5 min. Everything short of that is `ok` with a `reason` that says so:
  `starting` (before the first tick, up to 5 min), `deploying` (`scripts/deploy.sh` holds `data/deploy.lock` for a live pid, up to
  30 min; it also appends its start and end to `data/deploys.log`), `starved: …` (a tick older than three intervals and a minute: the
  process is alive, with the age and the load) or `failing: …` (the same, with the tick's error).
- The hook socket is a plain `Bun.serve` unix listener beside the API: its contract (mode 0600, empty stdout) is the
  hook's, not the API's.

## Perimeter

The API stays loopback. The door and the Console are published on the tailnet by dotfiles-private's `tailscale serve`
rows (the Console on :8797, to its loopback listener), and the perimeter is the tailnet ACL by device tag (a grant of
`tag:mac` and `tag:phone` to `tag:devhost` on tcp:8797), as Collie's (NL25); the deploy publishes nothing. There is no
per-request identity: anything that reaches :8797 reads what the owner reads, and no more than reads and the nine answer
verbs below, never a session start. The door holds only its own token; the orchestrator's is the owner's rights minus eight owner-only routes, and the Console proxy never uses it. Nothing that can start Claude Code is reachable from
another node. The Console listener reads, and forwards exactly the owner's nine answer verbs (a Decision's answer, an artifact's verdict,
annotation and its edit and delete, an Errand done, a held signal promoted or dismissed), guarded against a cross-site page (JSON only bar a delete, no cross-site fetch
metadata, no foreign `origin`, 64 KiB); it starts no session and cancels or reopens no Issue, and promote files one only
from a signal already held and dismiss files nothing. The artifact frame (`/frame.html`, `/frame/*`) is the one document the page frames and is
served under its own CSP (scripts, no network, sandboxed), not the page's, whose `script-src` stays `'self'`.

## Data

One database, schema `factory`; migrations apply under an advisory lock and a checksum. The cutover imported Issues,
events, decisions and evidence from the old schema (`apps/server/scripts/import/`, `docs/rewrite/cutover-runbook.md`), so
the KPIs keep their history. Usage and cost come from the `usage` schema by join, never copied.
`GET /v1/kpis?days=N` also returns each KPI's `history` (six consecutive windows of N days, oldest first, the last the current one; usage KPIs only for the last two) and the `windows` behind it.

`GET /v1/capacity-loop?days=N` (`factory read capacity-loop`, Improve's "Capacity" section) shows what the capacity loop did, computed in SQL by `read/capacity-loop.ts` over the window and per UTC day: Issues closed (an applied event into `closed`, as the cycle KPI counts), idle seat-hours (minutes with work queued of `max(seats - leads, 0)`, over 60, only where all three facts were read), minutes whose load was above the ceiling of that minute, the test-slot wait (`percentile_cont` p50, p90), the eight steps with the largest peak memory, the lead cost per repo (`read/lead-costs.ts`), the processes the reaper signalled (a dry decision is not counted) and the settings in force that tune the loop, so the weekly retro can name the one to change. `apps/server/test/read-models/capacity-loop.test.ts` restates every figure in plain SQL over seeded rows and fails when one drifts. `GET /v1/retro` (`factory retro`) carries the same loop as `capacity`: four per-day figures (`CAPACITY_FIGURE_KEYS`: `closed_per_day`, `minutes_over_ceiling_per_day`, `idle_seat_hours_per_day`, `slot_wait_p90_ms`), the whole `capacity-loop` model and `tune`, the one setting the fixed rules in `read/capacity-tuning.ts` would change first (over the load ceiling an hour a day: the seat bonus, then the seats, then the extra slots, down; seats idle behind a queue with the load low: the load ceiling up; a slot wait p90 of 10 min with the load low: the base slots up; null otherwise). `GET /v1/retro` also carries `build` (`read/retro-build.ts`): per repo over the window, the local check minutes from `factory.step_costs` (runs x duration, per closed Issue as `closed_per_day` counts them, the slowest steps by total minutes with median and p90 with a lead's `factory-<n>-<attempt> ` prefix dropped, the slot wait) and, through the `CiTimes` port (`githubCiTimes` in `adapters/selfwatch/github.ts`, at most three pages of finished runs since the window start), the median and p90 duration of CI runs on the default branch and on pull request heads and the share that passed only on a rerun (`run_attempt` above 1). A repo whose CI cannot be read is under `build.unreadable` with the reason and keeps its check figures. Its two totals, `check_minutes_per_issue` and `ci_p50_minutes` (the pooled median of every run read), are in `build.figures` and appended to `capacity.figures`, so the ledger measures them. The retro's part 2c reads `build` and files speed-ups per repo. A retro marker may name a figure key as its `kpi=`, so the ledger checks the last capacity change against the window (Issues closed per day must not fall); `capacity` is null on a server with no capacity settings.

## Tests

- **Unit** where logic is pure and dense: the machine, correlation, the gate, admission, the queue order.
- **Model test** of the machine.
- **Scenarios** (`tests/scenarios`): use cases end to end against a real server and Postgres with fake hc and agw. They
  are the acceptance suite, and a lead runs the ones its change touches as its proof.
- `make check`: frozen install, oxfmt, oxlint (type-aware), shellcheck, `tsc`, the boundary script, the retired-word
  check, the generated diagram and CLI freshness, `bun test`, scenarios.

## Not built yet

Rows in `docs/plan.yaml` carry each of these.

- **The Console** (NL1): `apps/console` (Vite, React, shadcn on Base UI, Tailwind 4 with Basalt's tokens, TanStack
  Router, Query and Table, a PWA), `tests/e2e` (Playwright), and the second loopback listener, published by dotfiles-private's serve row;
  it is read-only apart from the nine answer verbs, its perimeter is the tailnet ACL (NL25), and it can never spawn a session. The shell and Needs you (the answers
  in place; `/checkpoints/<id>`, the link of the owner's pages, lands on its item) the Flow board, the read-only Issue page (`/issues/<n>`, linked from a Needs you card) and the Chain are built; the other screens are not.
- **The 30-minute forward** (NL5): an unsolved alert reaching the owner. The old core's `FACTORY_ALERT_*` settings stay in
  the env allow-list for a rollback and the new core reads none of them.
- **Client work** in other repos: the Herdr glance, Hermes' factory skill, Argo's factory pages leaving for the Console.
