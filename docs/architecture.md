# Architecture: what is built

**A modular monolith on Bun: plain TypeScript and zod, Postgres as the only store, domains with no I/O behind ports,
Elysia at the edge, and a generated CLI.** It has been the running factory since the cutover of 2026-11-08. Words follow `docs/language.md`; the rules a change must keep
are in `AGENTS.md`; why something is as it is, in `docs/decisions.md`. This page says where things are and how they fit.
What is not built is the last section.

## Layout

```
apps/
  server/     Elysia app: domains, application services, adapters, read models; migrations in apps/server/migrations
  door/       the alert door: loopback, one token (`machine`), posts alerts and refusal reports to the server
  cli/        `factory`: commands generated from the OpenAPI document, plus the hook, slot, deploy-lock, merge-lock, land, follow, role and issue schema verbs
  console/    the Console: a Vite and React PWA (shadcn on Base UI, Tailwind 4 with Basalt tokens, TanStack Router and Query); the server's second listener serves its build
packages/
  contract/   zod schemas: every request, response and event; the OpenAPI source; the spool format the hook shares
  client/     typed client (Eden) and the CLI's transport, including the change-stream follower
  accounts/   the Claude Code subscription picker and the `claude-account` CLI (`packages/accounts/docs/accounts.md`): a pure rule over ports, no server or database (the server reads it in-process: `adapters/planning/accounts-source.ts`), one file buildable for a machine without a checkout
tests/
  scenarios/  use cases run against a real server and Postgres with fake hc and agw: the acceptance suite
  e2e/        Playwright against a seeded server: every Console screen, and the source of the README's screenshots
integrations/ the client pieces other machines install: the Claude Code hook entries, the Herdr glance mod, rd's contract, the Hermes fleet skill
config/       roles.json (tier and effort per role), infra.json (host to repo, for incidents), throughput.json (the counting epoch)
scripts/      deploy, verify, launch, env-file, merge-guard, the checks of the build (boundaries, retired words, vocabulary, public scan, README)
deploy/       LaunchAgent templates
docs/         product, language, architecture, operations, decisions, plan format, research, evidence
```

## The server

```
apps/server/src/
  kernel/        Result, ids, clock, keys, the event envelope, agw call types. Imports nothing else
  domains/       pure: types, rules, state machines, ports (interfaces). No I/O, no SQL, no Elysia
    intake/        signal envelope, trust and routing rules, fingerprints, incidents, the incident correlation
    planning/      projects, plans, the chain, queue order
    capacity/      accounts and windows, memory, load, repo claims, queue state, test slots, admission
    work/          the Issue: events, the total transition table, effects, the generated diagram
    leads/         attempts, the brief, notes, session state derived from hook events, the stop rule
    quality/       the ship gate, evidence, the watch and verify
    checkpoints/   Decisions, artifacts and revisions, collections, the owner's pages, rechecks
    errands/       Errands and requests, need, triage by rule, match keys, the desk, the Errand store and its ports
    loops/         what the steward and triage decide: stall rules, settling
  app/           use cases: one transaction to claim, the port call outside it, one to record
    loops/         the loop runner (`passLoop`, `createSaid`) and each loop's pass with its LoopSpec (`xLoop`)
  adapters/      postgres stores, hc terminals, agw, git, ntfy, filesystem blobs, the intake pollers, the hook socket, the uptime poller (`adapters/uptime/`: Argo's Kuma snapshot, `uptime` of `GET /v1/overview`: up, down, total, at most 10 down names, null when `FACTORY_UPTIME_URL` is unset, never read or older than 10 min; `FACTORY_UPTIME_TOKEN`, `FACTORY_UPTIME_EVERY_MS` default 60 s), the metrics export (`adapters/otel/`: the queue by reason, slot waits by reason and repo, step placements, seats per account and the load beside its ceiling, from `read/capacity-gauges.ts`, as OTLP/HTTP JSON gauges to ClickStack every `FACTORY_OTEL_EVERY_MS` (60 s) over the last 5 minutes; off without `FACTORY_OTEL_ENDPOINT`, a failed push is one log line and touches no loop; `FACTORY_OTEL_ENDPOINT` and `FACTORY_OTEL_KEY` are refs of `.env.server.tpl`)
  api/           Elysia route groups, auth and the caller policy
  read/          read models (SQL projections) for the API and the stream
  compose-*.ts   wiring of each domain; `compose-loops.ts` hands each loop its ports and builds the runner; main.ts boots, takes the process lock first and shuts down in order
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

States (stored; screens show the five words of `docs/language.md` "Where work stands", `workOf` in `packages/contract/src/work-words.ts`: Running, Paused, Ready, Held, Checking, and Planned for plan rows; `scripts/vocabulary.ts` fails `make check` on a state word in a screen's text): `settling`, `queued`, `working`, `waiting`, `watching`, `closed`. `apply(state, event)` is a total table in
`domains/work/table.ts`: every `(state, event)` cell is written down as a transition with its effects, a named refusal
or a named ignore, and a missing cell fails `tsc`. The diagram and the wait table in `docs/language.md` are generated
from that table.

**The owner's pause (`paused`).** `factory issue pause <id> --reason "..." [--until <iso>]` (`POST /issues/:id/pause`, owner and orchestrator) records `paused`: from `working` the Issue waits as `paused` and the lead hears it once (`note_lead`, the wait begins told); from a stall (not `lead_gone`, whose new attempt a resume would skip) or a `timer` wait the pause replaces the wait with no effect (the lead has no turn, and hears it with the resume); a second pause updates it in place; a dependency, `external` or person wait, an Issue no lead has started, a watch and a closed Issue refuse. The wait is not a stall, so the steward and the Judge never see it, a lead's `block`, `defer`, `ask`, `ship` and `close` are refused with the pause named, and the repo claim is free. It ends with `woken` from the owner or orchestrator (`factory issue note <id> "..." --wake`) or from the factory once `until` has passed (the planning pass reads `paused` with an `until` beside `timer`); the steward's wake is refused. It is Paused on you (`workOf`), not a need, and the retro's owner waits do not count it.

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
  (`agent:<repo>`), the alert door (Kuma and HyperDX), and two pollers: GitHub (the owner's new issues and failing
  checks, a failing one filed as an `incident` so it takes the fix's place beyond the repo's `leads` and the lead of every
  other Issue of the repo with an open pull request is noted once; anyone else's need the label and are held) and launchd (a
  LaunchAgent's state). Infra alerts (memory, disk, load, swap, silent hosts, containers) are ClickStack alerts through the door (A4), not a poller. `repo` comes from the route, the door registry or the caller, never from an outside payload.
  **App feedback** is a door source of its own: `POST /feedback/<app>` with the app's token (`feedback-<app>` in the door's
  tokens file) becomes `POST /signals/feedback`, one envelope for every app (`FeedbackRequest`: app, version, route, title,
  text, link). It is a signal from `feedback:<app>`, trust `outside`, whose text opens with an `app/version/route` header;
  the repo is the door route `(feedback, <app>)` or none, and the fingerprint is the repo (or app) and the title, never the
  version or route, so one complaint from two builds is one.
  **A monitor with no route** is counted, and the settle pass deals with it without the owner: one whose name says a
  project (`domains/intake/place.ts`: the project name is a run of the monitor's words, the longest and only match) or
  that has a `<name> - Push|Door` sibling routed gets that route (`set_by` `factory:name`), up or down; one down past
  10 min with no place is filed in `FACTORY_HOME_REPO` when set, else, past `unroutedHeldMs` (6 h), held once as a signal
  with no repo (the owner or the Judge promotes it with one). Setting a route for a monitor that is down files its last
  alert in that repo (Kuma notifies on a change only) and answers the held signal.
- **Backlog sweep.** With `FACTORY_GITHUB_BACKLOG=1` the GitHub poller's first pass after a start also reads every open issue
  of each polled project (oldest first, pull requests out) and files it through `receive`: the label's and the author's as
  `machine`, everyone else's `outside` (held). It carries `writeback: false` and no `admitted`, so nothing is ever written to
  GitHub for it (promoting a held one keeps that); one `github backlog:` log line per issue says the outcome. A replay is idempotent (the subject and event keys), and a sweep
  that could not read a repo whole runs again on the next pass. Unset it after the sweep.
- **Who may file where.** `domains/intake/rules.ts` gates a signal: a work repo hears only the owner (NL18), an unknown
  repo hears no one, and a project hears the automatic sources its `signals:` lists. The door's are routed.
  One exception to the work-repo rule: a lead's signal (`from agent:<its repo>`, `filer` set by the CLI) whose own Issue the owner filed (origin `you`) is held, not dropped, so the owner can promote work it owes a work repo; any other agent signal there is dropped (`work_repo`). The `screen` loop never reads such a signal (a work repo's words go to no workflow, and the last look never dismisses it): it stays held in Needs you.
- **Incidents.** Alerts of the monitoring sources on one host or dependency inside a window join one incident: the VPS
  down fires HyperDX (its infra and app alerts) and Kuma, and there is one Issue. The window is a setting (`FACTORY_INCIDENT_WINDOW_MIN`).
- **Amend or new.** A loop's finding (friction, hygiene, selfwatch, throughput: `intake.api.file` with a `LoopFinding`) is
  matched by its key alone (loop, class, repo, subject; `findingKeyOf`, a subject row `finding:…`): an open Issue of
  that key takes it as a note, one closed within the fingerprint window counts it as a repeat, else it files anew; no
  title match and no workflow call (an open Issue filed before the key existed is taken over once by its title's
  fingerprint), and an agent's own signal is never matched or offered for amending to an open Issue a finding filed. An
  amend by title match or workflow keeps a subject row for the signal's fingerprint, so the same words again are a repeat.
  A repeat of a fingerprint inside its window changes nothing. A signal that carries the retro marker (`Retro: <date> kpi=…`, the last words of its text) is one recommendation with its own number to move: it skips the title match and the workflow and files its own Issue (only its own fingerprint folds it into an open one). An owner or agent signal that matches an
  open Issue clearly (title overlap) amends it and reaches its lead as a note. Otherwise, unless a fingerprint, subject or
  open incident already settles it, the `factory-triage` workflow sees the repo's open Issues and those closed in the last
  day (outcome, reason) and answers amend `<open Issue>`, "already settled: `<closed Issue>`" or neither (file anew): a
  settled answer acks `dropped`/`settled` and stores the signal dismissed by the judge, for a person's request and for a
  `down` alert alike. The request waits for the workflow at most `triageWaitMs` (8 s, under the client's 10 s): later, or never (the line is down), it files anew and the run goes on unwatched; the same signal sent again rejoins it by its key. `POST /signals` therefore answers from the local database whatever the network does. The workflow side (agent-workflows `factory-triage`) must learn `settled`; until it does the extra
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
  10 minutes at least).
- **Loop guard.** A change a loop made never fires that loop again.
- **Stop the line.** While a repo's alert is unsolved, only its fix is admitted.

## Capacity and leads

- **Admission** (`domains/capacity/admission.ts`) is pure and decided again at every claim, in this order: queue state
  (`drain` starts nothing), the project's **doctor** (kind `doctor`, `domains/capacity/doctor.ts`, `adapters/doctor/`: `doctor: make doctor` in a `project.yaml` is a
  read-only command of seconds that exits 0 when this host can run the project and otherwise exits non-zero with one line per missing prerequisite and its fix;
  it runs in the project's own checkout under a 60 s timeout, a red reading stands 5 min and a green one 1 h, one run per project at a time, kept in memory so a restart asks again;
  while it is red every Issue of the project stays queued, the reason `<project> cannot run on this host: <first four lines>`, and the hygiene `check` probe is skipped with the same words,
  so a project needs no `hygiene.check: false` for a lab it lacks; a doctor that cannot run (no `make`, no `doctor` target in the checkout, a timeout) is no reading and the project is admitted), the **boot grace** (kind `boot`, `domains/capacity/boot.ts`: while the host's uptime, from `kern.boottime`, is under 30 min,
  no new lead until the five newest minute samples, all taken since the boot, show a load under a quarter of the ceiling and the newest
  sample's memory is under 80 % in use, then at most one lead per 2 min; resumed leads count against the seats as always; the reason reads
  "host booted N min ago: …"; an unreadable uptime applies no grace and says so as a note), the host's 1-minute load (kind `load`; and the **throughput rule**, below), its memory (swapouts and swap against ceilings; the swapouts are the higher of the pass's own rate and the minute samples' last 300 s, `sustainedSwapoutMb`, so a lull between bursts does not open the gate; the memory that a
  lane's `memory` reserves for its running leads and the candidate counts as swap in use, `docs/plan.md` "Lanes"; then the
  learned fit (and, after the memory rules, the disk fit: kind `disk`, `domains/capacity/disk.ts`, "A binding cap and the disk fit" below): a repo with at least three sampled attempts is refused, kind `memory`, when its median lead (the median of its newest ten attempts' peaks) does not fit into
  the free memory of the newest host sample (not older than 5 min) less headroom (the larger of 2 GiB and 8 % of RAM) and less what the running leads are still expected to take (`leadGrowth`, `domains/capacity/leadcost.ts`: each claim that started under `RAMP_MS` (2 min) before the host sample the free figure comes from, or after it, whose repo has a learned size takes that size less what its newest sample holds, 0 when it has none, never below 0: an older lead is in the reading, and a lead holds the same within its first minute as ten minutes on (475 against 520 MiB over 239 leads, 2026-11-15), its peak being a burst that no age settles, which the headroom and the swap and pressure ceilings hold; a lead resumed from a wait is a new process and starts again; a lead admitted in the same pass has no sample and takes the whole figure, so one pass cannot admit several against one reading; a repo with no learned size keeps the lane's constant; the refusal says "N young leads still take X GiB more"); the running leads' test peaks are not reserved here, the slot grant holds them back (`SlotFit`); it
  replaces the lanes' `memory` for that repo's leads, never refuses with an unknown figure and never the only lead on the host).
  **What a lead is learned to take** (`learnLeadCost`, `domains/capacity/leadcost.ts`): an attempt's peak is its worktree's largest
  sample of the six hours before its last one, from the repo's relearn point on; the figure is the median (nearest rank) of the
  newest ten attempts' peaks, except that a falling cost is believed sooner than a rising one: when the newest three **settled**
  attempts (ended, no sample for 10 min, or run 30 min) all peak below that median, it is the largest of the three (the refusal
  says so). Too early is still caught by the swap and pressure ceilings and the slot grant; too late is idle seats with work
  queued. `factory capacity relearn --repo <name> [--at <time>]` (owner, orchestrator and a lead, whose `set_by` reads `agent`: an Issue's own ship step may set a point; `lead_relearn`, `migrations/1034_lead_relearn.sql`;
  default now, never in the future) ignores the repo's samples before the time: with fewer than three attempts after it the repo is
  on its lane's memory prior as a new repo is, and `factory queue order` carries a note per repo with a point (and the refusal
  says "learned from the attempts since …"). `read/lead-costs.ts` keeps the same window and point, with its plain p80, beside it (the burst a lead reaches, not the size the fit reserves). The
  candidate's lane (`lanes: {apple: 1}` in `project.yaml` caps the leads of a resource class inside the repo, a fix is
  never held; `domains/capacity/lanes.ts`), the repo's claims (`leads: N`, 64 when the project states none, which is no cap beyond the host (memory fit and load above, the accounts below), and at most 64, a larger value is clamped with a warning in `factory project show`; a repo states a smaller `leads` only for a shared resource the factory does not model (not its merge window, deploy queue or disk, which `factory merge-lock`, `deploy-lock` and the disk fit hold), with the reason in a comment beside it, and a cap that binds while seats idle is a finding (NL32, NL48); plus one for a fix; `pace` allows one), then an
  account with room. **Seats:** each account has its own cap (`FACTORY_ACCOUNT_LEADS`, `iu=20,me=10,me2=10`; an account not named takes `FACTORY_LEADS_PER_ACCOUNT`, at most 64; `factory capacity get` shows each account's `leads` beside its `cap`, and the `cap` refusal names every open account with its leads and cap). **Accounts are read in-process from `packages/accounts`, and the package alone decides (`adapters/planning/accounts-source.ts`):** the poll (once a minute) calls its `readStatus` (the registry, the cache files, the modes in force; no shell-out, no `FACTORY_CLAUDE_ACCOUNT_BIN`, no registry path of the factory's own: `CLAUDE_ACCOUNTS_REGISTRY` and the package's resolution) and stores, per account, the windows beside the package's verdict for the bulk lane: whether it takes work, its place in the order, why not and when it opens again (`capacity_readings`, `bulk_*`, `closed_why`, `opens_at`). The server keeps no window limit, weekly pace or room-left order of its own; `claude-account rank --lane bulk` and `factory capacity get` show the same order. The pick takes the open account with the lowest place, skipping accounts at their lead cap or loaded since their sample. An account the owner paused, drains or reserves is the package's business (`factory accounts mode <id> paused --until <iso>` writes the override through the package, so `claude-account mode` sees it; `factory accounts status` is `GET /v1/accounts`: the package's status with the seats taken and free and the leads running beside it). An account a lead's turn ended on a 401 for stays closed (`account_auth_marks`) until its login Errand closes. A reading the poll has not renewed for ten minutes admits nothing. An account is paced by sample (one new lead per quota sample) only when it has a 5-hour window above 70 %; an account with only a weekly limit, or a window below that, takes leads up to its cap in one pass. A lead that runs into the wall (`limit_stop`) stalls its Issue as `wall` and continues when the window resets: the wait is the reset of the window that closes the account, or, while the newest sample was taken before the wall and does not show it yet, the reset of the window nearest its ceiling when that window is within 10 points of it (the package's `wallResetAt`, stored on the reading, read by `windowOf`; a rate limit far from any window is a throttle and wakes the lead as before), so the steward neither wakes it early nor nudges it and `lead_idle` stays quiet (a stalled Issue is not a working lead). While the window is closed and another account is open with seat room (`pickAccount` over every account but the one it left), the steward moves the lead instead (`seats.move`, `moveWalled`): the attempt's assignment and its claim go to that account and the Issue is woken with the move in its detail. `noteLead` delivers that wake by ending the session and starting the same session again (`claude --resume`) under the new account's `CLAUDE_CONFIG_DIR`, the way a dormant lead is revived, and stores the account on the lead's row. Nothing is copied: the transcripts of every account lie in one `projects/` directory (the other accounts' `projects` is a symlink to the default one, `dotfiles/docs/claude-accounts.md`). The cost is one uncached read of the whole context, since the prompt cache is per account; it is only paid against a wait of hours. No other account with room: the lead waits for its window as before. **Seat raise:** when work is queued for the account cap and each of the newest five minute samples shows a load
  of at most a quarter of the ceiling and swap below its ceiling, the pass raises every account's cap by the leads that fit into the
  free memory (`domains/capacity/seats.ts`, at most `FACTORY_SEATS_MAX_BONUS`, default 2, 0 is off); never the repo's `leads: N`, never
  past an account's window, and the `cap` reason says `(raised by N: the host is idle)`. **The throughput rule** (`DEFAULT_LOAD_PER_CORE`, `DEFAULT_PROCESS_CAP` in `domains/capacity/host.ts`; `hostRule` in `app/planning-settings.ts`): the load ceiling in multiples of the cores (`FACTORY_LOAD_PER_CORE`, default 3, so 36 on 12 cores) and a cap on the host's process count (`FACTORY_PROCESS_CAP`, default 1800, from the newest minute sample's `processes`, not older than 3 min; an unread count applies no cap), because the panic class is a process storm, not memory; an over-cap host is refused with kind `load` and "N processes (cap M)". Both limits are always on, with no setting that turns them off (the Console's load ceiling is the one in force). `factory.admission_shadow` (`migrations/1024_admission_shadow.sql`) is no longer written; dropping it is a later row. An env file that still sets `FACTORY_LOAD_RULE`, `FACTORY_SLOT_AIM` or `FACTORY_LOAD_CEILING` starts: `scripts/env-file.sh` drops the line with a warning for one release. The first that says no names itself and its numbers as the queue reason. It never spills to another
  account past a window or a cap; with every account closed it waits for the first opening. Owed Issues are served
  before new ones, in the repo and on the account: a woken lead is the same session on the account it was admitted on, so the
  account cap never refuses its resume (only the repo's claims and its lane do), and from the moment its wait ends it counts in
  its account's leads, so a new lead cannot take the seat it will run on. A lead in a wait that gave its claim up is idle and
  counts nowhere. A herd woken at once (a red master closing and waking a dozen deferred leads) takes the repo's places in
  order of its waits, oldest first, up to `leads: N`; the steward counts a refusal for a claim as a stall only when a claim
  would be granted to that lead now, and names the account it resumes on. The gates (lead cap, loaded) stay the factory's; whether an account is open and the order of the open ones come from the package, read in the same poll as the windows.
- **A turn that ends on an API error** (`domains/leads/apierror.ts`, `app/leads-api-errors.ts`, a step of the leads tick). Claude Code
  fires `StopFailure`, never `Stop`, when a turn ends on an API error (hooks reference, "StopFailure": `error`, `error_details`,
  `last_assistant_message`), so the session looks mid-turn to anything that waits for a `Stop`. The hook (every `error` type now,
  no matcher) spools it as `api_error` (a `rate_limit` stays the `limit_stop` wall); a session whose hook did not run is found
  by its transcript: a turn open and silent for `FACTORY_API_DETECT_MS` has the end of its transcript read (`TranscriptTails`,
  the last `assistant`/`user` record with `isApiErrorMessage`, its `error` and `apiErrorStatus`) at most every
  `FACTORY_API_PROBE_MS`, and the same fact is stored. `deriveSession` reads an `api_error` as the end of the turn
  (`SessionView.apiIncident`: the errors since the last clean `turn_ended`), so a note waiting for the turn to end is delivered.
  A prompt the account's closed window refuses (a resumed lead's first message) fires `UserPromptSubmit` and nothing after it: a
  turn open and silent for two minutes, with no process in the lead's tree, on an account capacity reads as closed (the table is read fresh, and does not depend on quiescing) is stored as
  the `limit_stop` the hook missed (`app/leads-held.ts`), so the Issue stalls as a `wall` and is woken or moved like any other.
  `kindOfApiError` reads the fields before the words: a 401 or an expired or revoked token is **auth**; a 429, 5xx, a
  timeout or reset, `server_error` (also mid-response, which adds "your last response may be cut off, re-check what you did" to
  the note) and a 403 typed `authentication_failed` (a Cloudflare challenge: 10 of 10 on 2026-11-13, none needed a login, though
  Claude Code prints "Please run /login") are **transient**; anything else is left to the steward. Transient: one `continue`
  (a `resume` delivery, key `resume:<session>:<incident>:<n>`) after 1 minute, then 3, 10, 10, 10, five at most per incident; three
  or more leads failing within five minutes are one **edge incident**: one clock, one `continue` per `STAGGER_MS`
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
  check its background tasks and report. A report (a Decision asked, a deferral) settles the quiet only while no news came after it: an answer, verdict or note
  that arrived after the report with no turn begun since is unheard, and the quiet counts from it (issue 1190). A session mid-turn, whatever a tool in it is doing, is never read. A turn that
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
  `disposed_at`). `factory issue ship` and `factory issue close --outcome done` (not `dropped`) are refused while an owner annotation on any of the Issue's Specs or Concepts has none, naming
  each. The Console shows the disposition under the comment; the retro's taste part carries it, and an annotation declined twice for the same reason is a
  candidate standing rule.
- **A repeated stall is not asked twice** (`repeatedStall` in `app/loops/steward.ts`, `decideStall`). A stall of the same
  cause as the one the steward's last Decision of this attempt answered, whose detail reads alike (`sameWords`: the share of
  words, digits dropped, at least `SAME_STALL`) to that stall or to any block of the same cause the lead made since the
  answer (a lead that wakes from a hold rewords its block, each wording close to the last), or a `blocked` stall that comes
  within `QUICK_REBLOCK_MS` of the answer with no report of the lead between them (a lead that cites the answer it was just
  given reads 0.1 to 0.4 alike, and one stand-down was asked 47 times), with no `noted` by the owner or the orchestrator and no `reopened` since
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
  asleep: a timer still running is information, and the Overview shows the waiting Issue. It is derived from the stored waits on every
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
  approved (`looks_good`/`with_notes`) and every dependent or cancel target being an Issue of the Replan's project (a removed edge's dependent may be another project's open Issue when all its heads in that edge are this project's), then
  edges added and removed and Issues cancelled through `addAfter`, `removeAfter` and `cancelIssue` as the orchestrator
  (the avoidable-touch counts read the owner alone). `/planning/after|unafter` and `cancel` stay owner only: a lead never
  edits the chain except through an approved Spec. The one cancel an agent has is `factory issue withdraw <id> --from
  agent:<repo> --reason ...` (`POST /issues/:id/withdraw`, `withdrawIssue`): the filer takes back an Issue made from its
  own signals, only while it is `settling` or `queued` and only when every signal on it came from that source; it records
  `cancelled` by the factory with `by` set, so the owner-touch counts do not read it. `--from` is the source as
  stored (`agent:<repo>`, what `signal list` shows), compared as written. Like `signal file`, it is self-asserted: the
  agent token carries no identity, so the check guards against a mistake, not against another agent.
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
  lead mid-turn is asked again until its turn ends, and a lead whose terminal is gone is the lead gone. A note is never typed
  into a terminal that runs no agent (`HcTerminals.type` refuses it): a live terminal with a shell in it (herdr-core brings
  every kept terminal back as a login shell after a host restart) has its session started again over it, as a dormant
  lead's is, with the note after a line saying the host restarted. A lead whose hooks
  say its turn ended for `forceNoteAfterMs` is typed to whatever herdr-core's status reads, when the screen shows an empty input
  box (no dialog, no running turn): a resumed session read `working` for a day while it sat at its prompt (issue 1190). Before the typing
  the lead takes its repo's claim back (`resumeClaim` through `claims.resume`): a wait that ended left it without one, and
  a full repo refuses so the outbox tries again later. Trust follows the stored actor: a `noted` whose actor is `owner`
  is typed as "a note from the owner" and binds the lead (the contract says so); the factory's, steward's and Judge's
  (and any record without an actor) stay "a note, as data". The brief lists the owner's earlier notes in their own section.
- **Quiescing** (`app/leads-quiesce.ts`, `domains/leads/quiesce.ts`, a step of the lead tick before the outbox). A lead whose Issue
  waits for a person, a timer or another Issue holds no claim and needs no process, yet its `claude` is 200 to 290 MiB. After
  `FACTORY_QUIESCE_AFTER_MS` (30 min) of a quiet wait the factory ends it (`hc kill`: a
  `--keep` terminal whose program was killed on purpose is `finished`, not a shell, so the finished terminal stays only as
  the record of the model and effort it ran on) and marks the attempt `dormant_at`; worktree, branch, tab id and the session
  id from the hooks stay. Never quiesced: a stall (the lead is alive and the steward acts), a session mid-turn, with
  background work or an API error, a lead with any process under it (a `factory merge-lock`, `deploy-lock`, `slot run`, a
  test or a shell all run under the lead and carry its `FACTORY_SESSION`; its own root must be in the `ps` table too) or a
  granted slot whose directory is its worktree. The wake is a `note_lead` like any other: after `claims.resume`, a dormant
  lead's session is started again under the same key and tab (`HcTerminals.revive`: `claude --resume <session>` on the model and
  effort of the finished terminal, the note as its first message, so nothing is typed), paced by `app/type-pace.ts`. A fresh
  start and a resume share one argv (`HcTerminals.argv`) and both carry `--strict-mcp-config` with no `--mcp-config`: no
  `.mcp.json` or agent-file MCP server of the repo the lead works in starts inside it (proved on Claude Code 2.1.325 in
  dotfiles `docs/browser.md` §Strict MCP: the flag blocks a project server and is accepted with `--resume`, and leaves plugin
  tools, tool search, hooks and skills working). A launcher that adds `--mcp-config` or a `--plugin-dir` server re-proves it. A
  failed start is retried by the outbox; the third, or a refusal, is the lead gone. `followLeads` never calls a dormant
  lead lost. It does call lost a lead of a `working` Issue whose terminal lives but runs no agent (`terminals.find`:
  `agent` false for every live terminal; the hooks of such a lead read `gone` or `idle` from before the restart): past
  the grace it opens a row of `lead_losses`, starts the session again with `--resume` and a first message that says the
  host restarted and its background work is gone, and closes the row when the agent runs again; the third failed start is
  the lead gone. The open row is a `lead-no-agent` health line, and every row is a lost lead in the friction read. A pass
  starts at most `REVIVE_BUDGET_MS` of such starts; the rest wait for the next pass. The first turn of the resumed session is a prompt cache miss: the context is read uncached once, which a
  wait over the cache's lifetime (1 h) costs nothing extra and one between 30 and 60 min does.
- **The stop rule** (`domains/leads/stop.ts`): a lead that stops with nothing reported is sent back once with one line
  (the hook exits 2); the stop after that is let through and stalls nothing, because a finished background task can restart the
  lead milliseconds later (issues 1154, 1180). A lead that stays quiet is the steward's idle path: a note, then the `unreported`
  stall. A stop with background work still running is no stop.
- **Finalize** (`app/leads-finalize.ts`), once per attempt and in this order: the claim goes back, the terminals close,
  the transcripts are archived, the worktree and branch are removed when clean and its work is on origin's default
  (the worktree is found by the path it was made at, because a lead may detach HEAD or rename the branch; its HEAD and the
  branch must be on the base, or a shipped commit must be, which a squash leaves as the only trace). When the Issue is closed, the same step
  cleans every `factory/<issue>-*` branch, local and on origin (`adapters/git/branches.ts`): a dropped or cancelled
  Issue's go, the others when their work is on origin's default (ancestry, an empty merge, a shipped commit, a merged
  pull request); the rest are kept and the reason is recorded with the worktree's.
- **Test slots** (`domains/capacity/slots.ts`): a host-wide semaphore around the whole `make check`, so parallel checks do not
  pile their load; `factory slot run` takes a slot, says once on stderr that it is queued for one (and how long it waited when
  it gets it), and a wait past 45 minutes exits 75 without running. A server that is down never opens the gate for everyone at
  once (2026-11-14: a deploy's restart let nine waiting steps start together, load 15 to 206, and the boot took 72.8 s): the
  caller first waits the restart out as every CLI call does (90 s, 10 minutes while a deploy holds its lock) and takes its slot
  from the server the moment that answers; a server still gone after that gives it one of `FACTORY_SLOTS` (default 2)
  host-local slots, lock files in `~/.local/state/factory/local-slots` taken like the deploy lock (a pid symlink, only a dead
  holder reclaimed), so the work that repairs a dead factory still runs and the host is not flooded. A command
  runs with `FACTORY_SLOT_ACTIVE=1`; a `slot run` inside one runs its command as it is, so the steps of `make check` do not queue
  again. While swap in use grows (`swapGrowing`: the newest of five minute samples is 0.5 points of RAM above the lowest older one), only the first step runs, whatever memory is free: the memory rule reads free pages, and swap filling up beside 70 % free is the host paging out what a second run would touch. The host's load in a scenario is the fake `sysctl`'s (`vm.loadavg`), never the machine's.
  Every step leaves a row in `factory.step_costs` (`POST /slots/:id/cost`: name, repo, the directory it ran in, peak resident size and CPU seconds of its
  process tree, duration, wait, exit code; the CLI measures with `ps` every 3 s and the renewals carry the size). The same post carries the step's **test results**
  (`migrations/1023_test_results.sql`): the CLI gives the command a fresh directory in `FACTORY_JUNIT_DIR`, reads every `*.xml`
  JUnit file the command left there when it ends (`apps/cli/src/junit.ts`: a `<testcase>` is `fail` with a `<failure>` or `<error>`, `skip`
  with a `<skipped>`, else `pass`; its suite is its `classname`, else the enclosing `<testsuite>`'s name; at most 50 000 results) and
  posts them as `tests` with the commit (`git rev-parse HEAD`) and whether tracked files differ from it, both read before the command
  starts. The server stores one `factory.test_results` row per result beside the `step_costs` row, with the OTel names where
  they exist (`test.suite.name`, `test.case.name`, `test.case.result.status` with `skip` as a custom value, `vcs.ref.head.revision`); the host loop drops rows older than 14 days, the cost
  ledger stays. Only a run inside a slot reports: the repos' check targets write JUnit when `FACTORY_JUNIT_DIR` is set (here
  `make check`, `check-fast` and `e2e` through `JUNIT` in the Makefile and the Playwright config; a bare `make test-unit` outside a slot writes none; the convention is in `docs/plan.md` "Check tiers"). The grant is
  `FACTORY_SLOTS` (default 2) as the base and `FACTORY_SLOTS_MAX` (default 6) as the cap: a lone step is always granted, a step
  below the base when it fits (or free memory is unread), one beyond the base while the load tripwire is clear (the load ceiling; `FACTORY_SLOT_EXTRA_LOAD` is accepted but no longer read) and it fits. **A step is learned per project:** a caller in a linked worktree (`<repo>/.claude/worktrees/<dir>`) whose step name starts with that directory's name (`factory-1146-1 unit`) is stored and learned as the project's (`basalt-ui unit`, `stepNameOf` in `domains/capacity/costs.ts`, on the grant and on `POST /slots/:id/cost`; the row keeps the worktree's directory in `cwd`), and old rows `factory-<n>-<a> <words>` of that repo seed the project's figure. **A step with nothing learned is sized by a prior, never refused for it** (`stepPrior`): the largest learned peak of a step of the project's last 14 days with the same last word, else the project's largest, else `DEFAULT_PRIOR_MIB` (2 GiB, about the p85 of every step peak on 2026-11-14: p50 0.3 GiB, p80 1.7, p90 2.5); the wait line says it is a guess, and the same prior counts as the growth of a running step that has none. It fits when its learned peak (the p80, nearest rank, of its 8 newest measured peaks; a run that ended within 90 s of a host sample at pressure level above normal or a swapout above the swapout ceiling (`DEFAULT_SWAPOUT_CEILING_MB`) is not learned from, as it measured a thrashing host; `factory read capacity-loop` `topSteps` shows `p80PeakMib` beside `maxPeakMib`) plus what the running steps
  still grow by (their learned peak less their size now) stays within the free memory of the newest host sample (not older than
  5 minutes) less a headroom of 2 GiB or 8 % of RAM, **which only a slot beyond the base keeps** (a step below the base needs its peak and the growth within the free memory itself, NL36); a waiter's `why` is shown in the CLI and the capacity view. No model is called. **Small steps pass:** the slot goes to the first waiter in line that fits, not only to the first: a waiter ahead whose step does not fit (memory) is passed, and `capacity_slots.passed_at` / `passed_by` record the first pass (the waiter's `why` then ends in `passed by "<step>" since N min; after M min its memory is reserved and only a step that ends before its start passes it`). Once a waiter was passed for 10 minutes its memory is **reserved** (backfill, `reservedStartMs`): the running steps' learned remaining runtime (learned run less time run; a holder with no learned run reads as ending now, so the reservation is never later than the true start; a holder that has run past its learned run is taken to need as much longer as it has overrun, since "ending now" is known to be wrong for it and would reserve a start that never comes, every step behind the head waiting and a base slot idle while it runs) says in how many minutes enough of their resident size is freed for the waiter's size, the growth of the holders that stay and the headroom. A step behind it that fits now still passes when its own learned run ends before that start, so the big waiter's start is not delayed; a step that runs longer, or has no learned run, waits and the line says so (`"<step>" ahead was passed for 10 min and its memory is reserved (free in ~9 min; this step runs ~12 min)`). A head with no reservation (size unknown, it does not fit even with every holder gone) or one that waits for something other than memory keeps the whole line, which is the starvation guarantee. A step also passes a head it still fits beside: its size, the step's and the headroom (none when both take a base slot) fit in the free memory plus the resident size of the holders granted before the passing began, less what the holders granted since will still grow (`headFitsBeside`), so the frozen head does not leave a base slot idle for the minutes its holders run (the 2026-11-17 line: 24 waiting, one of two base slots held, load a quarter of the ceiling, no swap); a waiter ahead that fits takes the slot on its own next call. The swap, load and slot-count rules hold for every waiter alike. **What a wait waited for** (`migrations/1038_slot_waits.sql`): each call of a waiter counts the time since its previous call to the reason that call was given (`slots` every slot taken, `memory` the fit, `swap` swap growing, `load` the load gate, `unsized` no learned size or free-memory reading, `line` the waiters ahead, a passed waiter's hold included, `cores` the cores fit, `class` a host-wide class held; `capacity_slots.why_kind` / `wait_split`). When the step is granted or the waiter leaves without a slot, `factory.slot_waits` gets one row (`outcome` `granted` or `gave_up`, the wait and the split in ms); a step granted on its first call has none. `slotWait.byReason` and `slotWait.byRepo` of `factory read capacity-loop` read it (count, total, p50, p90 and max per reason, and per repo with its reasons; a reason's figures are over the waits that spent time under it). The load gate's number is named in the wait line: the tripwire's words (`load over 36 in each of the last 5 minutes (…)`).
  **The slot aim** (`domains/capacity/slot-aim.ts`, `app/capacity-aim.ts`, always on):
  once a minute, right after the host loop stored its sample, the count of slots moves between 1 and `FACTORY_SLOTS_MAX`,
  starting at `FACTORY_SLOTS`, AIMD on the sample's pressure level (`kern.memorystatus_vm_pressure_level`) and swap in use: level 4
  drops to one slot; level 2, or swap in use up by half a point of RAM over the newest five samples, halves it; one more after
  five quiet minutes (level 1, swap steady) with a waiter in line and the load tripwire clear (below); an unread
  pressure holds the count. `factory.slot_aim` keeps the count and the minute the quiet began. Every minute also
  stores a row in `factory.slot_shadow` (the aim and the base slots and cap, holders and waiters, the reading, the reason;
  kept 14 days; the self-watch's `slot_line` reads it); `factory read capacity-loop` shows the count now as `slotAim.target`.
  The aimed
  count is the cap of a grant (the base stays `FACTORY_SLOTS`, lowered to the aim when that is less), a step beyond the base
  keeps the learned-peak fit and fits the cores (below), and its load gate is the tripwire;
  running steps are never touched. **The lead aim** (Issue 2271, `leadAimStep` in `domains/capacity/slot-aim.ts`, the same pass): the
  same minute and the same signals (pressure level 2 or 4, swap growing, swapouts over the swapout ceiling for five
  minutes, the load tripwire) move a second count, the leads the host takes (`slot_aim.lead_target`, `lead_since`). It
  is the gate of lead admission: no new lead while as many hold a claim as it allows (refusal `memory`
  with `part: 'aim'`, the last admission rule, so it names only a lead every other rule lets in; counted as `memory` in the queue reasons, not as `memory_fit`), and none while the newest sample, not older
  than five minutes, has no pressure level (fail closed). It is seeded at the leads running, adds one after two quiet minutes at
  level 1 when as many leads run as it allows and a queued lead is held by the aim alone (`leadWaiters`, read from the queue
  view), and a warning, swap growth or swapouts set it to half of what runs (never below one; leads running are not touched).
  The learned-peak fit of a lead is then only the guard of what cannot fit at all: the learned figure against the free memory
  less what young leads still take, with no headroom (the headroom is kept only while the aim is unread).
  **The free memory is the kernel's own** (`host_samples.kernel_free_pct`, `kern.memorystatus_level`, `migrations/1054`;
  `freeMibOf` in `domains/capacity/costs.ts`): the factory's sum (anonymous pageable less purgeable, plus wired and
  compressed, the `memory_used_pct`) left 7.5 GiB at 2026-11-18 11:48 while the kernel said 57 % free at pressure normal, and
  on this host reads about 83 % used against the kernel's 69 % free; the sum stays as the fallback when the level is not read. A
  slot beyond the base keeps no headroom under the aim either (the pressure level is the margin); the step's peak plus the growth
  of the running steps must still fit the free memory. `slot_shadow` stores `lead_aim` and `leads_running` per minute. **The bottleneck rules** (issue 1743): *the tripwire* (`loadTrip`, `SUSTAINED_LOAD_SAMPLES`
  in `domains/capacity/host.ts`) is the load over the lead admission's ceiling in each of the newest five minute samples and
  still by the reading now (2026-11-14 to 16 had no run over the ceiling of five minutes: 174 of one, 27 of two, 5 of three, 1
  of four); one peak trips nothing, and with too few fresh samples the instant reading decides (`load 40 is over 36 (the load
  ceiling, too few minute samples …)`). *Cores*: a step's cores are learned like its peak (the p80 of its 8 newest runs' CPU
  seconds over their run, `learnedCores`; `DEFAULT_STEP_CORES` 1 with none), and a step beyond the base waits (`cores`) while
  the running steps' learned cores plus its own exceed the host's cores, so light steps run beside a heavy one; `factory slot
  run` reports the exit's resource usage, which counts every reaped descendant (the `ps` samples alone missed short-lived
  workers: 0.4 cores for a step whose host minutes said more). *Host-wide classes* (`stepClassOf` in `domains/capacity/slots.ts`):
  a step named `<repo>-apple` or `<project> apple` (the Apple slot's name in dotfiles `docs/apple-signing.md`) is of class
  `apple`, and one step of a class holds a slot at a time whichever repo runs it (`class`); a waiter held by its class is
  passed and never holds the line. Cargo builds are no class: the fit packs them. *The line's order* (`lineOrder`): a waiter's
  place is when it asked plus its learned run (median of its 8 newest), so a short step passes a long one that asked a little
  earlier; the place is fixed when it asks, which is the ageing. *The test line steers the lead admission* (`lineRefusal` in
  `domains/capacity/admission.ts`, kind `tests`): no new lead while more steps wait for a slot than run and half of them have
  waited longer than a step takes (the median run of the last day's `step_costs`); a fix is never held. Replayed over the 30
  hours to 2026-11-16 21:50 UTC it would have held admission 404 of 1781 minutes. The lead admission's `load` gate is the
  tripwire too, not the instant reading. `factory capacity` still shows the configured `FACTORY_SLOTS` and `FACTORY_SLOTS_MAX`; the aimed count is
  `slotAim.target` of `factory read capacity-loop`. Steps run at normal priority: a test of
  `taskpolicy -b` and its neighbours is in `docs/research/2026-11-14-taskpolicy-steps.md`.

### Steps off the mini

Issue 1793, the Spec "Steps that run off the mini" (rev 3) and the planning session's measurements of 2026-11-17. A
repo names its steps in `project.yaml` `steps:` (`docs/project.md`): the Makefile target, what each `needs`, and
`remote: true` when it passes on Ubuntu 24.04 in the step image. No host is named in a repo's file: the step host is the
owner's setting, `FACTORY_STEP_REMOTE_TARGET` (an ssh alias; unset, every step runs on the mini) and
`FACTORY_STEP_REMOTE_PROJECTS` (the projects admitted to it). One line, two hosts:

- **Placement** (`app/capacity-slots.ts` `touchSlot`, `domains/capacity/remote.ts`). The mini's rule is as before over the
  rows that are not the VPS's (`capacity_slots.host`). When it makes a caller wait, the caller can run off the mini (the
  CLI sends `remote`), its project is admitted, its step is declared `remote: true` and needs nothing only the mini has
  (`mac`, `apple`, `secrets`, `services`; a step of the host-wide class `apple` never, whatever a file says), the VPS gets
  it when `decideRemote` finds room and `finishesSooner` holds. Room: a probe at most 90 s old, production's own pressure
  stall (`system.slice` memory and io `some avg10`) not over the pressure line (below), the disk under the 85 % its alert pages on with a new copy
  counted, the step's peak beside the running steps' peaks and the mini's headroom rule in `MemAvailable`, its cores in the
  idle ones. Sooner: its learned VPS run (unknown: 1.7 times the mini's, as measured) against the expected mini wait (the
  holder that frees its slot) plus its mini run. There is no fixed share of the VPS.
- **The pressure line** (`kernel/remote-pressure.ts`). Each probe reading is stored once (`remote_samples`: memory and io
  pressure, and how many step containers ran). The samples taken with none running over the last 3 days are the baseline;
  with a day of them (at least 24 h between the first and the newest, 200 samples) the line is just above each pressure's
  p99 (the larger of half a point and a quarter of the p99 on top, at most 10 %), else 1 %. At rest the VPS reads 0.00, so
  a flat 10 % meant production already stalled a tenth of the time. The line is derived from the samples at each read, so
  the baseline sits beside it in Throughput's "Steps by host" (`tests.remote.pressure`).
- **Why a step ran where it did** (`step_placements`, one row at each grant of a step its project declared remote): on the
  VPS, or on the mini because a slot was free (`free`), the VPS had no room (`no_room`), would not finish it sooner
  (`not_sooner`) or the step was held (`held`). The reason is the VPS's last refusal while the step waited, kept in the
  process; a restart reads `free`. Throughput lists each such step with its runs per host and these counts.
- **The probe** (`adapters/remote/probe.ts`): one `ssh` of at most every 30 s, started by a placement read and never awaited
  by it. It reads cores, load, memory, disk, the PSI and the step containers, and removes a step container whose slot is
  gone (older than 2 min, the CLI killed with its session up).
- **The run** (`apps/cli/src/remote-step.ts`). The worktree travels as a git snapshot: a copy of the index, `git add -A`,
  the `carry` paths forced in, `commit-tree` on HEAD (the worktree and its index untouched); pushed to the project's bare
  repository on the host (`factory-steps/<project>.git`, with `origin/<default>` so a step that diffs can), checked out in the
  slot's worktree (`factory-steps/<project>/<n>`), 0.4 to 1.4 s on a warm copy. The image is the repo's `dockerfile` or the
  factory's (Ubuntu 24.04, git, jq, make, shellcheck, the bun of `packageManager` and the PostgreSQL 16 server binaries: `initdb`, `pg_ctl` and
  `postgres` on `PATH`, `PG_BIN_DIR` set, issue 2114), built once per content and per image revision (`factory-step:bun-<bun>-r<n>`,
  `IMAGE_REVISION` in `remote-step.ts`, bumped when the image changes without its bun). A step starts and stops a private cluster in
  its own container (loopback and a unix socket need no network, a non-root uid needs a passwd entry: the image's `ubuntu` is uid
  1000, the step host user's); there is no `needs` word for it, because every factory-image step has it and a repo's own
  `dockerfile` carries what it needs itself. The install runs in a container
  with the network, the step in one with none (`needs: [network]` keeps it), both under `--cgroup-parent
  factory-steps.slice`, `--cpu-shares 2`, `--oom-score-adj 1000`, a memory ceiling of 1.5 times the learned peak (at least
  1 GiB), `--cap-drop ALL`, `no-new-privileges`, the host user's uid, mounted at the caller's own path; the step gets
  `FACTORY_STEP_CORES` (the idle cores at the grant) and `FACTORY_STEP_MEM_MIB`. Production wins by priority, not a
  partition. A whole no-op step costs 1.9 s.
- **Retention** (`adapters/remote/trim.ts`, issue 2035; measured 2026-11-17: `factory-steps` 7.2 GB, slot worktrees 1.6 GB
  each with `node_modules`, the bun cache 1.9 GB with no bound). The probe starts one ssh of a shell script at most every
  6 h (`TRIM_EVERY_MS`), apart from its own call, after a probe that saw no step container; the slot and cache parts of the
  script do nothing while one runs or docker does not answer. It removes a slot copy (`<project>/<n>` and `<n>.run`) whose `.run`
  directory, rewritten by every step of the slot, is older than 7 days (`COPY_IDLE_DAYS`), prunes the bare repository's
  worktree record and keeps the bare repository; and a whole bun cache entry no install read for 14 days
  (`CACHE_IDLE_DAYS`, by access time: the mount is `relatime`), tightening to 7, 3 and 1 day while the cache is over 3 GiB
  (`CACHE_CAP_GIB`). The same script removes a scratch directory `~/exp<issue>` of the VPS home (a lead's experiment; 13 GB at
  8 of them, 2026-11-20) in which no file or directory changed for 2 days (`EXP_IDLE_DAYS`); that part needs neither the step
  directory nor docker (files a container left root-owned are removed by a container when docker answers). A removed copy costs the slot's next step one checkout and install, a removed entry one download.
  A step that starts mid-trim and meets a removed copy fails as a host failure and runs on the mini. The server logs a
  line when something was removed (`steps: trim: removed ...`). The step images carry `factory.image=step` (set at build;
  an image built before it has none), so the host's daily `docker image prune` can keep them with
  `--filter label!=factory.image`; that prune is the vps repo's.
- **Results.** The exit code is the step's own. ssh's 255 and docker's or the setup's 125 to 127 are the host's failure:
  the caller goes back to the mini's line at its old place (`notOn`). A red on the VPS is not yet a red: the same call runs
  the step again on the mini, and only that result reaches the caller; a green there is stored `disagreed` with what the red
  run failed on (`step_costs.disagreement`: the failing test names from its JUnit with their remote duration and the
  timeout its output names, else the last 40 lines of the output). `step_costs.host`, `tree` (the snapshot's tree) and
  `disagreed` record it; the run time is learned per host, the peak and cores across hosts. The VPS's holders and pinned
  waiters are not the mini's test line for the admission. Throughput's "Steps by host" reads them.
- **The hold** (`kernel/remote-hold.ts`, derived from the ledger, never stored). A disagreement holds the step on the mini
  for 1 hour; each further one within a week of the hold's end doubles it, up to 7 days; the first green run on the VPS
  after a hold halves it (once; below an hour it is gone). The wait line says `it stays on the mini for 2 h, until <time>`,
  and Throughput shows the hold with its end. A test name that disagrees a second time files one signal to its project
  (`recordStepCost`: the test, its remote duration, the timeout), so the repo fixes the test instead of the factory losing
  the host.
- `FACTORY_SLOT_HOST=mini|vps` pins one call (a step that needs what only the mini has is never pinned off it);
  `FACTORY_SLOT_REMOTE=0` keeps one call on the mini.

Not built: proving runs in the host's idle time (a step earns its place before it is used), pausing step containers when
production stalls, a result cache keyed by the tree, a browser in the factory's image, a third host.

## Quality

- **Ship** (`app/quality-ship.ts`, `domains/quality/gate.ts`): the lead names merged commits, or none: then the factory
  finds what the Issue's branches landed (`Commits.landed`: each attempt's branch, newest first; by content: the first
  default-branch commit that holds every file the branch changed since it forked as the branch has it, a squash or a
  rebase; or, for a branch the default branch holds and the lead made a commit on, the first-parent commit that brought
  it in, a merge or its tip). Either way git must find them on the default branch and
  newer than the Issue's cut (its first attempt's, so a later attempt ships what an earlier one landed), read by the
  factory, never taken from the lead. Without that the ship is refused with the error named and
  counted as friction; so is the ship of an Issue flagged `checkpoint: spec` with no Spec submitted ("The Spec checkpoint", under Checkpoints). A review is recorded as evidence when agw's ledger covers the range, and its absence is recorded
  with its reason; it never refuses a ship (NL23). A commit agw routes to light is no absence (NL12: a review is owed at standard or deep), so a range whose only uncovered commits are light is recorded `not_required` and the friction loop does not count it; the brief has the lead read `agw review covered` before the merge. Whether a rebased, squash-merged change still counts as reviewed is
  agw's judgment (`covered`), not the factory's; `factory issue ship` prints one stderr line naming the range to `/review`
  when the answer is `uncovered`, or the reason when it was not read. The lead also states one line per acceptance line of the Issue
  (`--acceptance "met: ..."` or `"not met: ..."`; the factory parses no criteria), recorded as `acceptance` evidence and shown on the
  Issue page; the natural forms are normalised (a list marker, `AC2:`, bold, a dash for the colon), a line over 500 characters is cut, and a malformed line is refused (422) with the corrected `--acceptance` line built from what was sent; a `not met` never refuses, and a ship that states nothing is counted as
  friction (`unstated_acceptance`) like an unreviewed one. The pull request the commits landed through is read from GitHub
  (`adapters/quality/ci.ts`, the `Ci` port) and its head's CI recorded as `ci` evidence (`green`, `red`, `running`, `missing`
  when no pull request or no check was found, `unknown` when GitHub could not be read); it never refuses a ship, and a red
  or missing one is counted as friction (`unproven_ci`). One refusal reads CI at the ship (NL42): after a Watch regressed on the default
  branch's CI, a ship is refused while that CI is still red for the commit it lands at (`ciStillRed`, `quality-ship.ts`). A second refusal holds a repeat ship after an alert regression: while the Issue's alert is still down, a ship naming no commit the last accepted one did not is refused (`afterAlertRegression`, `alertStillDown`, `quality-ship.ts`; the alert state is `intake.subjectsOfIssue`, wired in `main.ts`). A third refusal reads the deployed version (NL49): under deploy mode `make`, a change that deploys is refused while `make version` names a commit that does not hold the landed one (`notDeployed`, `quality-ship.ts`; the check is the Watch's own, `Proof.run` with the version only). A project that ships by push (no `via: pr` rule) or has no
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
  a regression, unless it is a `make` target that failed the same way in the repo's last finished run before the ship, another Issue's watch, or in the last run of another Issue's watch of the repo that regressed in the last day and no pass of that Issue has answered (one red, one owner: that lead has it; the Issue's own regressions never count) (every failing line of this run, numbers aside, is among the failing lines of those runs together, so a drift list that shrank or a changed number is the same red, a line none of them had (an added drift item too) is not; the Regressed note opens with the failed checks' names and first failing lines): that one is stored `inherited`, counts green, is never retried and stays on the Issue's page; a regression returns the Issue to its lead, twice, then it stalls. A checkout that cannot be read is
  rechecked, never passed. In a project that ships through a pull request (`ship:` `via: pr`) verify also reads the default
  branch's CI for the exact merged commit (`ci` check; `mergedSha`, the first-parent commit that holds the ship's named commits, never the branch tip at the ship, which a later commit of another lead may have moved): green passes, red is red (unless the first parent of the merged commit, the default branch before the change, was red on the same first failing check: that red is stored `inherited`, counts green and is no regression of the Issue; a parent that is green, running, missing or unreadable leaves it the change's), and a run still running (or not yet visible
  within 10 min of the merge) is neither, so the watch is looked at again after `FACTORY_VERIFY_RECHECK_MS` and does not pass;
  one running past an hour is red, and no run at all after 10 min passes with that said (the repo may have none). A pending
  CI wins over a red `make verify` until it settles (`outcomeOf`: blocked first).
- **Reopen** (`app/quality-reopen.ts`) is the owner's, within 30 days of closing.

## Checkpoints

A lead's wait ends at a checkpoint: a Decision, an Errand (a person's hands), a Spec or Concept (a verdict), or a pull request's review by someone else. Each rule is one line with the symbol that holds it; the reasoning is in `docs/guide/checkpoints.md`. Paths are under `apps/server/src/` unless shown. The waits are in `domains/work/table.ts` (`waitHint`); the verbs in `app/checkpoints.ts`, each sub-machine in its `app/checkpoints-*.ts` sibling.

**Decisions** (`domains/checkpoints/decision.ts`)
- A form with a missing field is refused: 422 `missing_field`, nothing stored (`askDecision`).
- A recommendation to keep waiting is refused (`refuseNoOpDefault`); what waits on a person is an Errand.
- Settled in order: the Judge (`factory-ask`), the default after its wait when reversible, then the owner. Three Judge tries, 5 minutes apart (`decision_steps.tries`).
- A second ask from the same asker amends the open Decision; `guardVerdict` checks the Judge's answer.
- A lead that built on its default settles it with `factory decision take-default` (`takeDefault`).

**Errands** (`domains/errands/`, `app/checkpoints-errands.ts`)
- Need is `secret`, `hands`, `approval` or `place` (`need.ts`). A stated need is checked for presence, never stored.
- Before the owner sees it: rules, then `factory-errand`, then the owner. Rules: `screenByReview`, `screenByRule`, `screenByNeed` (`errand.ts`); `refuseKeyless`, `refuseBotCheck`, `refuseOffMacbook`, `verbFor` (`triage.ts`); `declinedMatch` (`app/checkpoints.ts`, `DECLINE_HOLD_MS`); `refuseHostClass`, `refuseUndialogable` (`errand.ts`). A refusal stores one `errand_refusals` row.
- The same need joins the open Errand (`matchKey`, `app/checkpoints.ts`); `eachJoined` tells every joined Issue how it ended.
- `--check` closes the Errand itself (`runCheck`, `resolveErrand`): exit 1..125 closes `not_needed`; 127 is `broken` (`checkVerdict`, `tellCheckBroken`).
- The desk pass (`app/loops/desk.ts`, `domains/errands/desk.ts`) pushes MacBook dialogs through `ask-human.sh` (dotfiles; the caller is `pushQueue`, `adapters/shell/ask-human.ts`), for `secret` and `hands` only. A `place` waits on Needs you; an `approval` never goes to the MacBook.
- Fixed gate verbs run with no dialog (`askHumanVerbs`, `verbFor`); a class the owner granted runs by itself (`kernel/auto-run.ts`).
- The desk pass is due on the owner's return, on the Console's push button, when it never ran, and at least every 6 hours.
- A done is checked: `finishErrand` reopens an Errand whose check still says needed, and keeps a failed run open (`run_*` columns). A command that fails twice ends (`retireFailed`, `MAX_RUN_TRIES`).
- Approve (`checkpoints-approve.ts`): the owner runs an `approval` on the mini. It is recorded consent, not a barrier.
- Turn back closes the Errand `turned_back`; the lead hears the note. The orchestrator's done needs `confirmedBy` and is never for `approval` (`finishErrand`).
- A request is an Errand no Issue raised (`request.ts`, `requestErrand`, `SCREENED_SOURCES`). It expires 7 days after filing without a check; a new request with the same `request_key` supersedes the open one.
- Recheck: an Errand or Decision in front of the owner past `FACTORY_CHECKPOINT_RECHECK_MS` (6 h) is looked at again (`recheckOpen`, `withdrawalReason`); each look is a `checkpoint_rechecks` row.

**Specs and Concepts** (`domains/checkpoints/spec-screen.ts`, `app/checkpoints-specs.ts`)
- A Spec flag (`checkpoint: spec`, or `gate` for one only the owner's verdict ends) owes a Spec. `shipIssue` (`app/quality-ship.ts`) refuses the ship until one exists.
- The screen is `screenSpecByRule`, then `factory-spec-screen`. A failed call is retried; after the third it passes unscreened.
- No verdict within `SPEC_WAIT_HOURS` (24 h, `packages/contract/src/lane.ts`): `recheckReviews` (`checkpoints-reviews.ts`) defaults it to `looks_good` by the factory, or `no_longer_applies` when its Issue closed.
- The orchestrator may give a Spec's verdict (`delegateRefusal`), never a gate's or a Report's; the owner's verdict replaces it (`replaceDelegatedVerdict`).
- A filed Spec (`factory issue new --spec`) is stored as `filed-spec:<issue>` and starts no wait.

**Reports and collections** (`adapters/postgres/collection-store.ts`, `checkpoint-store.ts`)
- A Report with no Issue never waits and never reaches Needs you. `artifact link` names the Issues it concerns; only a Report can be linked. `artifact retire` hides it from the list.
- A collection groups pages under one lead page; a page belongs to at most one (`409 refused`).

**Pull request reviews** (`adapters/reviews/pr.ts`)
- A required review by someone else puts the Issue in the `external` wait. The `reviews` loop reads each such pull request every 15 minutes and wakes the lead on an approval, a change request, a comment, a merge or a close (`factory issue defer --review`).
## Loops and agw

A loop is a named tick (`app/loops/runner.ts`) with a trigger (an interval, or a kick when something changed), a budget
and single-flight passes. Its deterministic part runs in the server; its judgment is a dedicated agw workflow with its
own prompt, tools and skills (`agent-workflows`), called through the agw port with an idle watchdog (`AGW_IDLE_MS`, 10 minutes: an `agw` process that prints nothing and does not exit for that long is killed with its process group; `agw` ends a pending wait every 110 s, so a run that is alive, however long, is never cut by the clock, `rules/agent-limits.md`). A call is
recorded in `loop_calls` under its key, so the next boot takes it up again. The clock runs from the loop's last pass, not from
boot (`loop_passes`, written at the end of every pass): the first pass after a restart comes when the interval since the
last one is up, at once if it never ran, so a 6-hour loop still passes on a server that restarts on every deploy.

Every workflow the factory calls is one entry of `WORKFLOWS` (`kernel/workflows.ts`): its agw name, request and answer schemas, the
prefix of its idempotency keys and its retry rule (tries and backoff). A caller asks `agw.run(name, request, key)`; the agw
port (`adapters/agw/port.ts`) is the only code that knows `agw`. Each entry has an example in `packages/contract/fixtures/loops.json`
that `apps/server/test/loops/wire.test.ts` parses, and that test also parses the copy agent-workflows holds when it is checked out.

Five workflows (`factory-ask`, `-triage` in settle mode, `-steward`, `-queue`, `-hygiene`) catch a model failure inside agw and answer with a neutral
result whose reason starts "<name> unavailable:". The agw port reads that reason for the entries marked `failsWhenUnavailable`: such an
answer is a failed call (`gone`), so the Judge's tries, the loops' rounds and retry windows run and nothing is recorded as asked,
settled or paged on it. Until agw lets those runs fail, the reason is the only mark.

| Loop | Deterministic | agw workflow |
|-|-|-|
| `leads` | spool replay, start, notes, finalize, the outbox | none |
| `planning` | read projects, file plan rows (`docs/plan.md`) whose `after` rows closed, mark the chain, wake dependency waits and timer waits whose time has come, file a Replan for a project whose chain head is in a long wait (one open per project) | none |
| `watch` | verify and probes | none |
| `settle`, `send` | rechecks of checkpoints at the owner past `FACTORY_CHECKPOINT_RECHECK_MS`, Decision steps, unscreened Errands and Spec revisions, pages | `factory-ask` (the Judge); `factory-spec-screen` (the Spec screen): stdin `SpecScreenRequest` `{ spec: { id, revision, title, source, content, format }, issue: { id, repo, title, kind }, precedents[] }` labelled untrusted data, stdout `SpecScreenAnswer` `{ verdict: pass\|settle, reason (1..300) }`, call key `factory-spec-screen:<artifact>:<revision>:<try>`; `factory-errand` (the Errand screen): stdin `ErrandScreenRequest` `{ errand: { id, summary, detail\|null (8000), command\|null, host: mini\|macbook\|null, need: secret\|hands\|place\|approval\|null }, issue: { id, repo, title, kind } }` labelled untrusted data; stdout `ErrandScreenAnswer` `{ verdict: pass\|turn_away, reason (1..300) }`; call key `factory-errand:<errand>:<try>` |
| `steward` | wake, re-check, requeue, deliver (`domains/loops/stall.ts`), nudge a quiet lead, note a watch whose checkout stays blocked, break a claim deadlock; while a project has a live lead, read its main checkout once a pass from local refs (`domains/loops/checkout.ts`): off the default branch or with tracked uncommitted changes, it is a `main-checkout` health line and, when its branch is a live lead's (`factory/<n>-<attempt>`), one note to that lead (once per branch state and clean/dirty); a branch no lead owns names no session and reaches no lead, no model | `factory-steward`: what a stalled Issue needs when the rules do not say |
| `triage` | fingerprint, routes, correlation window | `factory-triage`: kind, amend-or-new-or-already-settled (open and last-day closed Issues), likely `after` edges (held to evidence, below), `checkpoint: spec` for a change that needs a Spec first |

**Inferred edges** (`checkSettle` in `domains/loops/settle.ts`). A settle answer's `after` edge stands only when the filed title or text names the blocker (`Issue 1177`, `issue_1177`, `#1177`): a shared file or topic is no evidence that an Issue builds on another's output (2026-11-14: an incident fix and a Spec were chained behind a registry Issue and a 48-hour reading). An Issue the owner ranked at `prio` 400 or above (`RANKED_PRIO`) takes no inferred edge at all; the owner's `--after` is stated, not inferred. A dropped edge is recorded in the call's detail (`dropped: <why>`) and counted as `dropped`. An edge that stands is stored with `planning_edges.inferred_by` (`triage: <the answer's reason>`, `queue: <the edge's reason>` for one the queue loop adds; null for a stated edge; only triage's edges are held to the evidence rule, and `#N` also matches a GitHub reference), and the queue reason says it: `waits for Issue 1177 (inferred by triage: <reason>) to close`. Not built: an open pull request changing the same lines as evidence.

**Whether an edge held an Issue behind free capacity** (`planning_edges.ready_since`, `QueueEntry.readyWithoutEdges`). Each admission look decides an Issue its `after` edges hold a second time as if the edges were gone: nothing else of the chain keeps it out (`Ordered.withoutEdges`) and every admission rule passes for it against the claims as they stand. `recordReadiness` sets `ready_since` on its unsatisfied edges at the first such look and clears it on a look that finds it refused for another reason; a satisfied edge is never touched, so the value is final. An edge with `ready_since` held its Issue idle capacity from then until `satisfied_at` (not needed); one without held it while something else would have refused it anyway (needed). The edge's `inferred_by` separates the factory's edges from stated ones. Readiness is judged per Issue against the claims as they stand, so two Issues held behind one free lead each read ready: the value says the Issue would have been admitted alone, not that all of them could have started together. Null also covers an edge no look saw. The attempt's seat is stored the same way, as `lead_attempts.tier` and `effort`, set in the transaction that records `lead_started` (attempts before the column are filled from that event's payload), so cost per Issue and first passes can be joined to the seat by attempt.
| `queue` | per repo: cycles in the chain, the queued Issues that wait for nothing (an ask needs two), the queue's shape (asked once per shape; an edge the loop added is part of it), a budget (one ask per repo per `FACTORY_QUEUE_GAP_MS`, three repos a pass), the sweep of the edges the factory added (taken back when the files turned out disjoint or the blocker waited on the owner), the edges checked and added through planning (never against the owner's `prio`, never a pair the sweep took back, none while the loop's own kind of edge is mostly not needed) | `factory-queue`: `after` edges and a tie-break order; the order is recorded in `loop_calls` (loop `queue`) and the admission order reads it as the tie-break after size (see **The queue order for throughput**) |
| `friction` | the week's counts (`read/friction.ts`), cut at the counting epoch (`config/throughput.json`: nothing before it is counted), against the rules in `domains/loops/friction.ts`: a rate per Issue closed with a minimum sample of 10 closed, or a bare count for the serious patterns (a lead that stopped reporting, lead lost, undelivered note, which counts a note of an open Issue whose lead is still there, a closed Issue and a lost lead being no one to tell; a regression, and the `regressed` stall of the same Watch, is a rate of 0.05 per Issue closed from 3, NL37, NL52); retired mechanisms (the review gate, NL23) are skipped. One signal per pattern over its rule, 5 at most, filed on this repo through intake with the evidence Issues; a pattern whose Issue is open amends it with a note, and one whose Issue closed less than 7 days ago is dropped as a repeat (intake's finding key, the pattern key, with `LoopFinding.repeatWindowMs` counted from the close). The loop asks every 15 minutes (`CADENCE` in `app/loops/settings.ts`); a pass is due after a day, or when 200 Issues closed since the last pass (`FRICTION_PASS_EVERY_MS`, `FRICTION_PASS_EVERY_CLOSED`, whichever comes first, the volume read from the event log), read from `friction_passes`; every pass still reads the last 7 days, and the signal budget is the one `MAX_SIGNALS_PER_PASS` (5) that hygiene, selfwatch and throughput share (`domains/loops/budget.ts`); the pass files the retro signal when none was filed in the last 7 days (`retroFiledAt`, read from `intake_subjects`; `domains/loops/retro.ts`: one Issue on this repo whose lead reads `factory retro --days 7`, writes a Report that opens with the three largest sources of waste in hours (`waste` of `GET /v1/retro`, `read/retro-waste.ts`: queue by reason, slot wait, stalls, refused ships, waits on the owner, in Issue-hours) and files one signal per change with a `Retro:` marker line that the next retro's ledger reads; the signal's text says what the retro signals of the last 7 days led to, `read/retro-outcomes.ts`), a failure to file it only named in the pass line | none |
| `hygiene` | one project a tick (those with a `project.yaml`): a throwaway checkout of the default branch swept by the probes of the catalogue (`packages/contract/src/hygiene-catalogue.ts`, rendered as `docs/hygiene.md`; `adapters/hygiene/`), a full pass weekly (`FACTORY_HYGIENE_EVERY_MS`: every probe, the project's own `probe`s, then the judgment) and a daily pass of the probes the catalogue marks daily, promoted to a full pass for a repo with 30 commits since its last one; a repo with no commit on its default branch for 30 days is idle and gets its full pass (`deps` and the judgment) monthly and a `steady` one weekly (every probe the catalogue does not mark `idle: monthly`); `runrules` is dotfiles `rules/run-on-mini.md` read from the files (one finding per rule and file, `runrules:<rule>:<path>`), `browser` is dotfiles `rules/browser.md` (`browser:<path>`), `context` is the byte budgets of `rules/writing-for-agents.md` (key `context`), `project` is the lint of `factory project check` (`packages/project-lint`); `deps` and `advisories` are folded by `domains/loops/dependency-refresh.ts` into one `deps` finding per repo, filed only past the bar (a high advisory with a fixed version, a runtime major, a runtime minor 30 days old, or 10 rows behind; `docs/hygiene.md`), else named in the run's detail; no probe calls a model; at most 5 signals a project and pass, probe findings ranked in catalogue order and limited to 3, the rest named in `over_budget`; filed through intake as the project's own agent, each signal with its `Seat:` line. Before it files, the red findings of the probes that only read files (catalogue cost `file`, `REREAD_PROBES`) are read again when origin's default branch moved during the sweep, and only what the new head still raises goes on; then `planLifecycle` (`domains/loops/hygiene-lifecycle.ts`) reads each key's newest Issue: a probe that ran green closes an unstarted Issue as healed or tells a lead at work, a red key whose Issue closed done reopens it (at most twice), an open Issue holds its finding; every action is on the pass (`hygiene_passes.lifecycle`) and the Hygiene tab. Before `planLifecycle`, a probe whose catalogue entry has a `fix` (`stale`, bun `deps`) is fixed by script in the checkout (`adapters/hygiene/fixes/`, rules in `domains/loops/hygiene-fixes.ts`) and run again: what is green files nothing, a failed fix keeps the finding with its output, a fix that found no test slot is held one pass; for a repo that ships by pull request the bump lands as a pull request on `factory/hygiene-deps` inside the repo's merge window (`factory merge-lock`, held by the pass), merged by the method the repo allows once its CI and `make merge-guard` are green, and nothing is deployed (NL46); every fix is on the pass (`hygiene_passes.fixes`) and the Hygiene tab (NL44). A project's own settings are `hygiene: { check, reason, skip: [{ probe, reason }], probes: [{ name, target }], idleAfterDays, deps: { runtimeStaleDays, behindRows } }` in `project.yaml` (`docs/project.md`) | `factory-hygiene`: the stale and recently edited documents read against the code, at most the budget left (2 at least); its title is built from the kind and the path, so the same document is one pattern for intake; a failed ask is retried at the stored commit every `FACTORY_HYGIENE_RETRY_MS`, 3 attempts at most; a full pass only |
| `selfwatch` | every `FACTORY_LOOP_SELFWATCH_MS` (5 min), fourteen deterministic conditions (`domains/loops/selfwatch.ts`, the four of the factory's own capacity in `domains/loops/overload.ts`; all but `budget_breach` are the factory itself on this repo): `ci_red` (the two newest completed runs of a workflow on the default branch, or `FACTORY_SELFWATCH_BRANCH`, both failed; skipped and cancelled runs do not count; needs `FACTORY_GITHUB_TOKEN`), `migration_clash` (one number on two file names where one is on origin/master and the other on master or on any local or remote branch except a closed Issue's lead branch, bar `SHARED_NUMBERS`; two open branches that take one number with each other are left to `scripts/merge-guard.ts`; past 200 refs a pass the rest are named in a `refs-unchecked` finding of the same kind), `wait_overdue` (a `timer` wait past its `until`, a `dependency` wait whose Issues all closed, each plus `FACTORY_SELFWATCH_GRACE_MS`, 10 min), `lead_idle` (a working lead quiet past the steward's `idleLeadMs`), `inert_regression` (a `regressed` wait whose attempt's stored ship has `deploys` false and only inert paths), `heartbeat_stale` (`GET /health`'s heartbeat not ok: no successful leads tick for 20 min, or a database error the health probe has held for 5 min; a database-class miss is also read again twice, 5 s apart, as a second guard), and three of the host (read from the host loop's rows, so they hold only while it samples): `process_growth` (a process, by pid and program name (not `postgres`, whose footprint counts the shared buffers it maps: `SHARED_MEMORY_PROGRAMS`, not `kernel_task`, whose footprint follows memory pressure: `isKernelTask`, not Apple's transient `XProtectRemediator*` malware scanners: `isTransientScanner`, and not a tenant, a launchd job or VM no lead of this repo can shrink: the throughput loop's `tenant_growth_mib` reads it), in `host_process_samples` whose footprint rose by more than 1 GiB between the first and last of its samples in the last hour, seen over at least 30 minutes and sampled within the last 3; one subject per process, filed on the repo whose Issue runs it when the sample names one (a lead's or step's process), else on this repo; the figures and that owner are context, so one signal until the growth clears), `swap_growth` (`host_samples.swap_used_pct` read in 16 consecutive minutes, never falling and 0.5 points higher at the end without its largest one-minute step, so one burst that moves swap once and stays flat is no growth: 15 minutes in a row; one subject, `host`) and `process_storm` (`host_samples.processes` over the cap in the last 3 samples; the cap is `DEFAULT_PROCESS_CAP`, 2500, until the capacity layer's own process-count cap of `tp-leads` exists). A host with no sample in the last 3 minutes leaves the three host rows alone. The tenth, `budget_breach`, is a project's `budgets:` (`project.yaml`) against its last 24 hours of `step_costs` (`read/throughput-loop.ts`, `readBudgetFacts`): `fast` the median of the fast-tier runs (at least 3), `peak` the largest peak memory of a step, `fail` the share of steps that exited non-zero, a red `check-fast` (a lead's pre-push fix loop, which never reaches master) left out of both counts (at least 5 steps, and over only when the share held on the day before too, a whole day each: a one-day burst or a window the counting epoch cut is no breach; the failing steps by name and exit code, and the number of check-fast reds left out, are context of the signal, so a lead needs no database read). One subject per project and budget, filed on the project's own repo as its own agent, so a breach is one signal the pass after it happens and the next only after the figure was back inside; the day's figure is context, never hashed. A budget the day has too few runs to judge is not over, and a `fast` or `fail` figure over a window the counting epoch cut under a day is not judged (the ranking waits the same way; `peak` is a maximum and is). The four of the factory's own overload (the evening of 2026-11-14: load 200 twice, the Console 502, five causes found by hand, none by a loop), each read from rows that exist and each one subject until it clears: `load_over_ceiling` (`host_samples.load` over that sample's `load_ceiling` in the newest 10 consecutive minute samples, the newest within 3 minutes; subject `host`), `slot_line` (from `slot_shadow`, which the slot aim writes every minute: more than 8 callers waiting, `holders`/`waiters`, in the newest 15 consecutive minutes, subject `waiting`; or `holders` under the base with a caller waiting in the newest 5, which is the memory rule refusing a step the host could run, subject `base_empty`; the base is the lower of `live_slots` and that minute's `aim_slots`, because that is what the grant rule is handed: an aim of 1 with one holder is "all 1 slots are busy", the aim working, not an empty slot), `gates_passed` (judged per admission, an Issue's applied `admitted` event in the newest 10 minutes, never by the `leads` count, which a lead resuming from a wait also raises without asking a gate; set against the `host_samples` on either side of it, each within 2.5 minutes: past the load rule when the tripwire admission itself reads held (the load over its ceiling in each of the newest 5 minute samples before it, and over in the load admission read, which its `admitted` event records because a live reading under the ceiling clears a tripped tripwire and no minute sample shows it; an event from before that, or one with no reading, is judged by the sample after; with fewer fresh samples the instant reading, as admission does), so a short peak the rule lets through by design is no finding, past the memory rule when swap use or the swapout rate was over the memory ceilings in both; the seat cap is not judged, the idle host's seat bonus lets `leads` exceed `seats` by the rule; the comparisons are `overLoad` and `overMemory` of `domains/capacity/host.ts`, handed in by the loop; a load that fell under its ceiling by the reading (or, with none recorded, by the sample after) is a lead the rule let in; one subject `host`, the passed gates are its facts) and `routes_slow` (the p95 of the server's own route answer times over 5 minutes above 2 s with at least 20 requests (the nearest-rank p95 of fewer is the single slowest answer), measured in the process by `api/route-timer.ts`: every route but `/health` and the event stream, a request still unanswered counted at its age; subject `routes`). A host with no sample in the last 3 minutes leaves `load_over_ceiling` and `gates_passed` alone, no slot minute in the last 3 leaves `slot_line`. The signal of these four carries an evidence block after its eight lines, read when it is filed and never hashed (`overloadEvidence`; intake keeps a signal's text on one line, so every evidence line starts with `- ` and names its field): the slot lines with their reasons, the queue by reason (open `queue_intervals`), the newest host sample (load against its ceiling, leads and seats, memory used, compressor, swap, swapouts, pressure level), the CPU by class and repo over the newest 10 host minutes as cores (`classCpu`, `host_class_samples`; a `lead` group is work no test slot admitted, a `step` group one it did: the 2026-11-18 load of 148 was one repo's hand-run cargo, 4220 s of `lead` rustc against 987 s of `step`), the CPU accounting (the `top` header's busy share averaged over the same minutes, as cores of the host's, against the cores those groups account for: the remainder is what a once-a-minute sample cannot name, processes that start and exit within a minute and kernel time; 2026-11-20: load 36-51 at 0% idle with 3.5 cores named), the 15 busiest processes with `ps -o pri`, the scheduling priority of the server, the door and Postgres against a lead's `claude` (a control plane that runs at a lower priority than the work it controls was the first cause), and the last 6 lines of `data/deploys.log`. Filed through intake as the repo's own agent, 5 a pass at most. A subject is its newest row in `loop_findings` (loop `selfwatch`, the key `<kind>:<subject>`): filed once, and through the class gate (a kind whose Issues were mostly dropped files nothing); the same evidence files nothing; changed evidence is filed again under the same kind and subject, which intake's finding key turns into a note on the open Issue; a subject that no longer holds is cleared and files anew if it returns. The title carries the subject in words for the lead; a source that cannot be read (no token, no origin/master) names itself in the pass summary and leaves its open rows alone. Turning on `signals.github.checks` in `project.yaml` is the intake's own first-red signal; `ci_red` is the two-in-a-row one | none |
| `ci-ledger` | every `FACTORY_LOOP_CI_LEDGER_MS` (15 min), the CI ledger (`app/loops/ci-ledger.ts`, `githubCiLedger`): the finished workflow runs of the repo itself and of every stored project, queued, started and finished per run in `factory.ci_runs` (a rerun is queued at its latest attempt's start; read from the day before the newest stored run, 14 days back for a repo with none, at most 300 runs; pruned after 30 days). A repo it cannot read is a note in the pass summary, never a failed pass; one that is refused (outside the allowed roots, no github.com origin, a GitHub 403 that is not the rate limit, a 404) is a note once and is left alone for a day, kept in the server's memory (a restart asks again). A 403 or 429 with the rate limit spent is a plain error that passes by itself | none |
| `screen` | up to 10 held signals not yet screened (oldest first, `intake_signals.screened_at` null, `screen_attempts` under 5, `screen_retry_at` due), one call each, outside any transaction; the answer is checked before anything is done (`domains/intake/screen.ts`): a promote needs a known non-work repo (the signal's own, else the one named), a duplicate must be an open Issue of the repo it was shown, else the verdict becomes `leave` with a note; then `promote` or `dismiss` as `judge` (each looks at the state again: an owner who acted first is counted, not an error). A failed, unparseable or timed-out call (a missing workflow too) leaves the signal held and records the attempt with a backoff of `min(10 min * 2^n, 6 h)`; the pass still ends ok and its summary says `screen workflow unavailable` when every call failed | `factory-screen`: stdin `ScreenRequest` `{ signal: { id, source, kind, origin, repo, title, text, link, receivedAt }, openIssues: [{ id, title, kind, state }] (open Issues of `signal.repo`, at most 40, empty with no repo), projects: [name] (known projects that are not work repos) }` with title and text scrubbed and labelled untrusted data; stdout `ScreenAnswer` `{ verdict: promote\|dismiss\|leave, reason (1..300), repo\|null, duplicateOf\|null, recommendation (<=300)\|null }`; call key `screen:<signal>:<attempt>` (`screen:<signal>:<attempt>:final` on the last look, which sends other input for the same attempt). A held signal 72 h old (`FINAL_SCREEN_MS`) that was not screened since it got that old is on its **last look**: `final: true` in the request, failed calls not capped, and a `leave` is replaced by the factory (`decideFinal`): promote when the signal's repo is a known non-work project (the new Issue carries a `noted` steer: investigate, draft the reply, post nothing, raise the draft as an Errand), else dismiss with the reason. It leaves Needs you either way |
| `errands` | every hour (off with the tick), over the open requests (Errands with no Issue), oldest first, outside any transaction (`app/loops/errands.ts`): past `expires_at` closes `expired`; with a `check`, up to 20 a pass, exit 0 keeps it (`check_note`), exit 1..125 closes it `not_needed` by `check` with the output, and a check that could not answer (126, 127, 128 and up, a timeout, no start) keeps it open and is noted, named in the pass on the third run in a row; with no check, from 24 h old and again every 24 h (5 a pass), the still-needed look reads the request and the same source's other requests of the last 14 days (how each ended, scrubbed, cut) and only `not_needed` with a reason closes it by `judge`; a failed look is made again after 6 h. Every closure not by the owner is listed once in the `errands` category ("Errands closed without you") of `GET /v1/since`. A request the owner closed while a check ran stays his | `factory-errand-needed`: stdin `ErrandNeededRequest` `{ errand: { id, source, summary, detail\|null, command\|null, host, raisedAt, ageHours }, evidence }` labelled untrusted data; stdout `ErrandNeededAnswer` `{ verdict: needed\|not_needed\|unsure, reason (1..300) }`; call key `factory-errand-needed:<errand>:<day>`; a missing workflow fails the call, keeps the request and is named in the pass |
| `reviews` | every 15 min (`REVIEW_POLL_MS`; off with the tick), over the Issues in an `external` wait, outside any transaction (`app/loops/reviews.ts`): `gh pr view` / `glab mr view` in the repo's checkout; an approval, a request for changes, a review or comment by someone else after the first look, a merge or a close wakes the lead with `woken` (key `woken:<issue>:external:<since>`); a read that fails changes nothing and is named in the pass | none (`gh`, `glab`) |
| `desk` | asks every 15 min (off with the tick) whether the desk pass is due (the owner back after 2 h, which also starts it at once, the MacBook answering after it was down, his button, 6 h since the last, or a MacBook command never pushed), then runs it (`app/loops/desk.ts`): checks, a second screen, the MacBook commands pushed through `ask-human.sh push`, all of them on a return and one per pass while he is away (a hang guard of 30 min on the script) | `factory-errand` on the second screen |
| `fix-classes` | every 6 hours (repos checked as for hygiene): per project (those with a `project.yaml`), `git log --no-merges` on origin's default branch since 35 days (`adapters/hygiene/fix-commits.ts`), the commits whose subject is a conventional `fix`, those not in `fix_commits` yet classed by the rules of `domains/loops/fix-classes.ts` (scope `test`/`docs`/`ci` and the like, a subject naming a review; a commit no rule classes is `other`) and stored `by: rule`; no workflow is called | none. The classes are `FIX_CLASSES` (`docs/product.md` "Fix classes"). Read on Improve ("Fix commits by class", the last four weeks) and in `GET /v1/fix-commits` (`factory read fix-commits`) |
| `host` | every minute (`FACTORY_LOOP_HOST_MS`): one reading of the host (load, memory as the kernel's app (`vm.page_pageable_internal_count` minus purgeable), wired and compressor pages over RAM, as Activity Monitor's Memory Used (`sysctl` and `vm_stat`; summed process RSS counts shared pages many times), swap use and swapout rate through the capacity reader; and the same memory, the RAM, the swap in use and its size as bytes, `migrations/1044_host_bytes.sql`, which the Throughput page draws as GB, reading an older minute as its share of the newest known RAM), stored in `host_samples` with the capacity facts of that minute (`leads` = claims held, `queued`, `seats` = the sum of the enabled accounts' caps (`FACTORY_ACCOUNT_LEADS`, else `FACTORY_LEADS_PER_ACCOUNT`), `load_ceiling`; null when unreadable), rows older than 14 days dropped in the same pass. The same pass costs every lead: the one `ps` (`pid,ppid,pcpu,rss,comm`) and one `lsof -nP -a -d cwd -Fpn` (`FACTORY_LSOF_BIN`, 10 s) give each process's directory, `domains/capacity/leadcost.ts` assigns a process to the attempt worktree (live, or ended in the last 10 min) with the longest path containing its directory and adds all its descendants (a pid counted once), except what runs under a `factory slot run` (the class snapshot's `step` processes: a holder's tree and `FACTORY_SLOT_ACTIVE=1`, `stepNames` in `domains/capacity/classes.ts`; the slot grant weighs those steps against free memory itself, so the lead is not charged for them twice; a minute with no class snapshot stores no lead rows, as it cannot tell them apart), one `top -l 1 -n 5000 -stats pid,ppid,mem,time` (`FACTORY_TOP_BIN`, cached 10 s with the `ps` rows; its MEM column is the kernel's `phys_footprint`, shared clean pages left out, at 0.4 s for the whole host where `footprint -p` costs about 12 ms per pid) gives each process's physical footprint, summed per tree beside RSS (a process `top` did not list counts at its RSS; a failed `top` leaves the footprint null and the row RSS-only), and one transaction stores a `lead_samples` row per worktree (rss MiB, footprint MiB, process count, `outside_slots` true; kept 30 days; `migrations/1031_lead_outside_slots.sql` marked every earlier row false, and the learned cost and `read/lead-costs.ts` take only true rows, so a repo falls back to the lane prior until three attempts sampled outside slots exist). Admission still learns from `rss_mib` and its refusal says the figure is outside test slots; the footprint is recorded to be calibrated against it first. A failed `ps` or `lsof` records the host sample without lead rows and the summary says so. `read/lead-costs.ts` answers per repo the attempts, the p80 of the newest ten attempts' peaks and the newest peak, and the same two figures from the footprint (over the newest ten attempts that have one) with the median footprint-to-RSS ratio (`factory read capacity-loop`, `leadCosts`). `GET /v1/host` (`factory read host`) answers the last 24 h, each sample with its process count and user, system and idle CPU, with the top 8 processes by cpu and memory (one `ps`, cached 10 s) and the server's version and start time; a reading that failed is null. The same pass takes the **class snapshot** (`migrations/1022_host_classes.sql`, `domains/capacity/classes.ts`, `adapters/planning/snapshot.ts`): the minute's one `top -l 1 -stats pid,ppid,mem,time` (cached with the footprints above) lists every process with its footprint and cumulative CPU, joined by pid with one `ps -Eww -Ao pid=,ppid=,user=,command=` (user, executable, `FACTORY_SESSION`, a `factory slot run` holder and its name, `FACTORY_SLOT_ACTIVE`, a Lima instance in the command; the command line is dropped there), `launchctl list` (`FACTORY_LAUNCHCTL_BIN`: the label of each job launchd started), the shared `lsof` cwd map and one `lsof -p` on the Virtualization VM processes (the Lima instance whose disk they hold). Each process gets a class, first rule that holds: `step` (a slot holder's tree or `FACTORY_SLOT_ACTIVE=1`, with its lead's repo and Issue and the slot name without the `factory-<n>-<a> ` prefix), `lead` (the worktree rule above, or a `FACTORY_SESSION` naming an attempt, with descendants), `factory` (the server's launchd job and every job with a process working in the release directory), then by its launchd job: a Lima VM, helper or named instance is the tenant `vm:<instance>`; pid 0 and 1, root and `_` users, `com.apple.` labels and programs under `/System`, `/usr`, `/bin`, `/sbin` are `system`; an application (`application.` label, or an unlabelled app bundle: Chrome, Obsidian, the owner's Herdr terminals) is `owner`; another labelled job is the tenant of its label; the rest is `other`. CPU is the difference of a pid's cumulative time from the last snapshot (a new or reused pid counts all of it; a process that ended between two snapshots is lost; none at the first snapshot after a start). Stored per minute: one `host_class_samples` row per class, repo, tenant, Issue and step (footprint MiB, CPU ms, process count; a Postgres cluster counts the shared buffers its processes map once: its largest process whole, each other at its private rest, `isSharedMemoryProgram`) and `host_process_samples` for the 15 largest processes, any over 1 GiB and any grown 200 MiB within 10 minutes (program name only, kept in memory between passes); both kept 14 days, and complete hours roll up into `host_class_hours` per class, repo and tenant (MiB-minutes, peak, CPU seconds, minutes present; kept 400 days). `host_samples` gains `pressure_level` (`kern.memorystatus_vm_pressure_level`: 1, 2, 4), `kernel_free_pct` (`kern.memorystatus_level`, the share of RAM the kernel counts as available: what admission and the slot grant take as free memory), `compressor_mib` (`vm.compressor_bytes_used`), `processes`, `cpu_idle_pct`, `cpu_user_pct` and `cpu_sys_pct` (top's header; the last two from `migrations/1039_host_cpu_split.sql`), `vm_free_gib` (statfs of `FACTORY_VM_VOLUME`, default `/System/Volumes/VM`) and `collector_cpu_ms` (the CPU of every helper the loop ran since the last snapshot, from each child's resource usage: the collector's own cost, measured). A failed `top` stores no snapshot and null signals; a failed `ps -E`, `launchctl` or cwd `lsof` stores the signals but no class or process rows that minute (whole trees would land in the wrong class), and the next minute's CPU covers both | none |
| `digest` | every 3 h (off with the tick): for each project with a `project.yaml` (`source = 'file'`, work repos included; worktrees and a second directory of a name are the one project, `kernel/digest-scope.ts`) that has an Issue open or closed in the last 7 days, builds the digest in code (`digestOf` in `domains/loops/digest.ts`, from the Issues' titles, states and outcomes: shipped is done and healed of the window newest first, next what runs and then what is ready, risks a paused Issue with its wait reason and one dropped or cancelled in the window with its outcome, the headline counts them, the themes are the kinds of what shipped) and stores it as a new row of `project_digests` (project, hash of the digest, route `code`) when its hash differs from the newest stored one. No port is called, so the pass is one read and one write. `GET /v1/projects/digests` (`factory read project-digests`) answers the newest digest of each project with work in the window and its counts (done in 7 days and `counts.work`: running, paused, ready, held, checking) read from the Issues now, never from the model, by the one definition of the five words (`workOf` in the contract, `docs/language.md` "Where work stands"; Issues, never sessions) that the strip, the Overview list, the Overview sidebar, `perProject`, the project pages and the Herdr bar also use; the read token gets the counts of a work project and no words (the work projects share one entry named `private`) | none |
| `throughput` | once a day (`FACTORY_LOOP_THROUGHPUT_MS`; off with the tick; the last pass is in `loop_passes`, so a restart does not skip a day), no model call (`app/loops/throughput.ts`, `domains/loops/throughput.ts`, `read/throughput-loop.ts`): the **ledger** first, then the **ranking**, see "The throughput loop" below | none |
| `reaper` | every 5 min, no model call: ends the processes of **closed** lead attempts (`domains/loops/reaper.ts`, `app/loops/reaper.ts`). Closed = the attempt's finalization is done (`lead_finalizations.done_at`: claim released, terminals closed, transcripts archived, worktree removed or kept), never merely `gone_at` while finalization could still need the worktree; an attempt with no such row counts as live. One `ps -Eww -Ao pid=,ppid=,etime=,command=` (`FACTORY_PS_BIN`; macOS `-E` appends the environment) and the `lsof` cwd map (`FACTORY_LSOF_BIN`), 10 s each, give every process its `FACTORY_SESSION` (the lead key `lead-<issue>-<attempt>` its terminal's `factory.key` label also carries; only that value is kept, never the command line) and directory; a failed `ps` or `lsof` fails the pass and ends nothing. A process is a leak when its session names an attempt closed longer than 5 min with no live twin, or its directory lies inside (path boundary) such an attempt's worktree and inside no live attempt's (a worktree the finalization kept, `lead_finalizations.worktree_path` set, is exempt from this path rule: the owner may work in it to rescue what it holds; its session rule stays); an unknown session or directory, pid 1, this server and its ancestors are never touched, so a browser reparented to launchd is found where a process-tree walk is not. SIGTERM first; a leak that survived an earlier SIGTERM (same pid, not younger than recorded: a reused pid is a new process) gets SIGKILL on a later pass; the pid's age is read again just before each signal. One transaction records a row per signal in `reaped_processes` (pid, session, worktree, program name, signal, reason, age; kept 30 days). | none |

**Finding classes.** `friction`, `hygiene` and `selfwatch` hold a noisy kind of finding back (a selfwatch class is the condition's kind; a held kind is named in the pass line, and does not use up the pass's cap). A class is the loop plus the finding's
first key segment (`judgment:<kind>` for a judgment): the probe, the kind of judgment, the pattern group, across all
repos: the noise is one probe misfiring everywhere, a few Issues per repo, so a per-repo class would never reach 3. The fact is
`factory.loop_findings` (which class filed which Issue, with the figure it was filed against; below); the state is derived from the Issues' outcomes
(`domains/loops/classes.ts`) and never stored. Of a class's ten newest decided Issues (done, healed, dropped or
cancelled), with at least 3 decided, a share of dropped or cancelled above one half **holds** it for 14 days after its last
Issue closed: it files nothing, and the held findings are named in the pass record's `overBudget`. After the hold it is on
**probation**: one Issue at a time across repos, none while another of its Issues is open in any repo, until one closes done, which forgives the
history before it. Held and probation classes show on Improve ("Held finding classes") and in `GET /v1/finding-classes`
(`factory read finding-classes`); the `runrules` probe is the class `runrules`, listed from its first filed Issue. Deviation: the owner asked for a rollup signal, and this is the section and the read
model, not a signal: an agent-trust signal files an Issue, and no loops page exists to carry it.

**The ledger.** `factory.loop_findings` is the one table of "which Issue did this loop's finding open", for all four loops (`migrations/1061_loop_ledger.sql`, `domains/loops/ledger.ts`, `app/loops/ledger.ts`): one row per Issue, with the loop, repo, class, key, when and by which signal it was filed, and **the figure** the finding was filed against (a friction pattern's count, a hygiene finding's items, a selfwatch condition's number where it has one, a throughput finding's `before`; null when it has none). Once the Issue closed, the next pass of the loop reads the same figure again (a pattern no longer counted, a key a probe judged and did not raise is 0; a source that could not be read waits) and stores a **verdict**: `moved` (the figure fell: a count is exact, a measured figure of the throughput loop keeps its 10% band), `flat`, `worse`, or `unmeasured` (the Issue ended dropped or cancelled, or the finding keeps no figure). A key a loop files again says in its signal `Last time: Issue N at figure X, now Y (moved).` when its newest earlier Issue closed. The throughput loop's rows also carry the target, unit, cost and the ship its after is measured from (its status is the verdict and the ship: no verdict and no ship is `open`, a ship is `shipped`, an `unmeasured` row with no ship is `dropped`), and the self-watch loop's the evidence hash and when it saw and cleared the subject: its memory of a subject is the newest row of its key. The old tables `selfwatch_findings` and `throughput_findings` are no longer written (a later contract migration drops them).

**What each loop yields.** `GET /v1/loop-yield` (`factory read loop-yield`, Improve's "What the loops yielded") answers per signal-filing loop (friction, hygiene, selfwatch, throughput) over the last 7 and 30 days (`read/loop-yield.ts`): the passes it recorded (null for selfwatch and throughput, which keep no row per pass), the signals it filed, the Issues those opened or reached, how they ended (done, healed, dropped, cancelled, still open), the median seconds from filing to close, how many of the done ones moved their figure (`moved`, and `movedShare` of the done ones: a done Issue whose figure was not read or whose finding keeps none is not moved) and the three kinds of finding with most Issues. An Issue counts in the window it was filed in; all four loops' Issues come from `loop_findings`. `apps/server/test/read-models/loop-yield.test.ts` restates every figure in plain rows.

## API, client, CLI

- **Elysia** with zod through Standard Schema and `@elysiajs/openapi` for the document. Who may call a route is the one
  table in `api/policy.ts`; a walk of the OpenAPI document fails the tests on a route without a row.
- **The CLI is generated** from the OpenAPI document (`apps/cli/scripts/generate.ts`), one command per operation, keeping
  agw's contract: `--format json|plain`, data on stdout, messages on stderr, the exit codes, never a prompt. The hook, slot,
  deploy-lock, follow, retro (the retro bundle: `GET /v1/retro` plus `retro-transcripts.ts`, a pass over the lead transcripts for seconds by tool category, idle gaps, tool-error classes and `make check` runs, no model), role and issue schema verbs are hand-written where their contracts demand it. The CLI authenticates itself on the host: with no `FACTORY_TOKEN` and no `FACTORY_READ_TOKEN` it resolves the owner token from the deployed release's `.env.tpl` through `secrets-run` (`credentials.ts`; a set token wins, offline verbs and `health get` never resolve), so a session files with `factory issue new` and `factory signal file --from agent:<repo>` and needs no wrapper. Commands of the old CLI answer with
  the way to the same thing (`apps/cli/src/retired.ts`). A flag's help and the client-side validation of a body (bare Issue
  numbers normalised to `issue_<n>`, every violated limit named, exit 2, nothing sent) derive from the contract schema of the
  request body (`apps/cli/src/body-schema.ts`); `--schema` prints that body's JSON Schema.
- **A restart is waited out** (`packages/client` `sendPatient`, `apps/cli/src/restart-wait.ts`): a deploy stops and starts the
  one process, so a call that finds the port closed retries with a backoff (0.5 s to 5 s) for up to 90 s
  (`FACTORY_RESTART_WAIT_MS`), 10 minutes while `data/deploy.lock` names a live pid (`FACTORY_DEPLOY_WAIT_MS`), and says
  `server restarting (deploy), waiting` once on stderr; then the usual `server unreachable` (exit 7). A refused connection is
  retried for every verb (nothing reached the server); a reset or a timeout only for a read, since Bun's `ECONNRESET` does not
  say whether the request was read. An answer of `version_conflict` (409: the Issue moved between the server's read and its rolled-back write) is asked again up to three times, 0.1 s, 0.2 s, 0.3 s apart, for every verb. `health get` (monitors, `make verify`), and the hook never wait; `slot run` waits a restart out like every other call, then takes a host-local slot. The Console
  shows "Server restarting, reconnecting" for up to 3 minutes after the stream drops or a fetch gets no answer, keeps the data
  on screen, retries with a backoff and refetches everything when the stream greets again (`apps/console/src/lib/restart.ts`).
  `scripts/deploy.sh` restarts less: a deploy whose commit is live and healthy restarts nothing (`FACTORY_DEPLOY_FORCE=1`
  restarts anyway), one whose master moved while it built builds the newer commit (`DEPLOY_ROUNDS`, 3), and the release's
  pending migrations are dry-run in a rolled-back transaction (`apps/server/src/migrate-check.ts`) before the old process is
  stopped. Why no gapless handover: `docs/decisions.md` NL31.
- **Callers and tokens.** The caller is decided by the bearer token alone: `owner` (`FACTORY_TOKEN`, required), `orchestrator`
  (`FACTORY_ORCHESTRATOR_TOKEN`), `agent` (a lead), `machine` (the door), `signal` (Hermes) and `read`; every other token is
  optional, all differ, and a caller whose token is unset does not exist. The orchestrator, the owner's delegate agent, is on
  every owner row except the eight that are the owner's own judgment or hands (a Decision's worth-asking flag, an artifact's
  annotations with their edit and delete, an artifact's needed mark, an Errand's approve, a held signal's promote and dismiss). Its events carry the actor `orchestrator` and a Decision it answers is settled by
  `orchestrator`, so the owner-touch counts (`read/kpis.ts` `ownerTouch`) read the owner alone and its steering is the friction
  group `orchestrator_steer` (`steer:*`). A lead hears its note exactly as the owner's. Rows from before the token (the owner's
  actor with `via: orchestrator`) count as steering too.
- **One contract** in `packages/contract` builds every body; a body that does not parse is exit 9.
- **Reads** (`/v1/*`, `read/`): needs, flow, chain, Issues, sessions, signals, accounts, queue, loops, friction, finding classes, fix commits, kpis, retro (`GET /v1/retro`: the KPI table with history, the friction counts, the lead sessions with their transcript paths, samples of Issues worth reading and the ledger of earlier retro signals; the read token gets no path and no words), host, since (the Console's "since you were here" band: `read/since.ts` counts what the event log, Decisions, Errands, signals and incidents say after a start; only the owner's read moves the one-row `console_visit` marker, `app/visit.ts`: a read 30 minutes after the last starts a new visit at the old `seen_at`, the first looks back 24 h) and
  the change stream. Health lines (`read/lines.ts`) are kinds `door`, `account`, `loop`, `checkout` (a blocked watch), `lead-no-agent` (a working Issue whose lead has no agent in its terminal) and `main-checkout` (a shared main checkout off its branch or dirty under a live lead). The stream (`read/stream.ts`) resumes from an opaque cursor without losing or doubling a change.
  `GET /health` carries the heartbeat and answers from memory: a background probe (`read/health-probe.ts`, every
  `FACTORY_HEALTH_PROBE_MS`, 10 s, one read at a time) holds the database facts (`queueMovedAt`, the door lines, a database error),
  so a request never waits for Postgres and answers within a second at load 200. `ok` is false only for a stopped factory:
  no successful leads tick for 20 min (`TICK_DEAD_MS`; `FACTORY_HEARTBEAT_STALE_MS` replaces it for a scenario), no first tick
  5 min after a start on a host that is not starved (a load of twice the CPU count or more keeps `starved: no tick has succeeded yet` ok until the 20 min), or a database that errors for 5 min. Everything short of that is `ok` with a `reason` that says so:
  `starting` (before the first tick, up to 5 min), `deploying` (`scripts/deploy.sh` holds `data/deploy.lock` for a live pid, up to
  30 min; it also appends its start and end to `data/deploys.log`, the end with `unreachable_s=N`, the seconds from stopping the old process to `/health` at the new sha, which `GET /v1/throughput` sums per day as `deploys.days`, and `stopped_s=N started_s=N`, its two halves: the old process told to stop to gone, then to `/health` ok), `starved: …` (a tick older than three intervals and a minute: the
  process is alive, with the age and the load) or `failing: …` (the same, with the tick's error).
  **Up but useless.** `/health` never queries the database, so on 2026-11-14 it answered while every database-backed route timed out. The heartbeat therefore also carries
  `routeP95Ms` and `routeSamples` (additive: the four names stay): the p95 in ms of the answer times of the server's own routes over the last 5 minutes
  and how many requests that is (`api/route-timer.ts`, in the process, from memory; `/health`, the event stream and the routes that wait on a port by design (`POST /signals` with `/alerts` and `/feedback`, which wait up to 8 s for triage, and `POST /issues/:id/ship`, which waits for git, agw and GitHub) and the report reads (`GET /v1/retro`, `/v1/throughput`, `/v1/kpis`, `/v1/seats`, which scan days of history and take seconds by design) are not timed, a request still
  unanswered counts at its age; requests begun in the first 120 s after the process starts are not timed, since a deploy's cold, loaded restart is not a useless server; null with no request). The reader outside the server is the dev host's Uptime Kuma push monitor (the heartbeat pusher in
  the dotfiles repo), which today reads the four names: it should push down while `routeP95Ms` is over 2000 with `routeSamples` of 20 or more (below 20 the nearest-rank p95 is the one slowest answer, which a cold request after a deploy is), the
  same line `routes_slow` draws inside the server. That change is the pusher's repo's (a signal was filed there); until it lands the figure is read by hand
  and by the self-watch, which runs in the process that starves.
- The hook socket is a plain `Bun.serve` unix listener beside the API: its contract (mode 0600, stdout empty bar the compaction line) is the
  hook's, not the API's.

## Perimeter

The API stays loopback. The door and the Console are published on the tailnet by dotfiles-private's `tailscale serve`
rows (the Console on :8797, to its loopback listener), and the perimeter is the tailnet ACL by device tag (a grant of
`tag:mac` and `tag:phone` to `tag:devhost` on tcp:8797), as Collie's (NL25); the deploy publishes nothing. There is no
per-request identity: anything that reaches :8797 reads what the owner reads, and no more than reads and the owner's fifteen write
verbs below, never a session start. The door holds only its own token; the orchestrator's is the owner's rights minus eight owner-only routes, and the Console proxy never uses it. Nothing that can start Claude Code is reachable from
another node. The Console listener reads, and forwards exactly the owner's fifteen verbs, his eleven answers, a collection's pin and unpin and an account's mode set and clear (a Decision's answer, an artifact's verdict and its needed-me mark,
annotation and its edit and delete, an Errand done, an Errand approved, a held signal promoted or dismissed), guarded against a cross-site page (JSON only bar a delete, no cross-site fetch
metadata, no foreign `origin`, 64 KiB); it starts no session and cancels or reopens no Issue, and promote files one only
from a signal already held and dismiss files nothing. The artifact frame (`/frame.html`, `/frame/*`) is the one document the page frames and is
served under its own CSP (scripts, no network, sandboxed), not the page's, whose `script-src` stays `'self'`.

## Data

One database, schema `factory`. Migrations in `apps/server/migrations/` apply under an advisory lock with a checksum. Usage and cost are never copied: they join the `usage` schema at read (`read/usage.ts`), and an Issue's `insights` say `partial` while a lead is alive.

## The counting epoch and the three answers

`config/throughput.json` holds one ISO time (`FACTORY_THROUGHPUT_FILE` points elsewhere); a missing or bad file stops the start. Nothing before it counts: throughput, the capacity loop, friction, the ranking's window facts and lead costs start at `max(asked start, epoch)` and say so as `epoch.cut` (`kernel/epoch.ts`). No row is deleted; retention prunes on its own. A median over earlier days waits three days after the epoch, and the ranking files nothing from a window under a day (`MIN_RANK_DAYS`, `app/loops/throughput.ts`). An improvement filed before it reads `unmeasured`. `read/throughput-answers.ts` writes the three answers the Throughput page opens on: `host`, `queue`, `cost`.

Each read has a test in `apps/server/test/read-models/` that restates its figures in plain SQL over seeded rows.

| Read | Route | Module | Answers |
|-|-|-|-|
| KPIs | `GET /v1/kpis` | `read/kpis.ts` | seven KPIs with parts, the figures beside them, six history windows |
| Seats | `GET /v1/seats` | `read/seats.ts`, `seats-model.ts` | the light-seat and cheap-reviewer gates |
| Capacity loop | `GET /v1/capacity-loop` | `read/capacity-loop.ts`, `capacity-tuning.ts` | closed Issues, idle seat-hours, slot waits, queue by reason, edges, the setting to change first |
| Retro | `GET /v1/retro` | `read/retro.ts`, `retro-build.ts`, `retro-taste.ts` | capacity figures, build minutes per repo, the owner's taste |
| Throughput | `GET /v1/throughput` | `read/throughput.ts`, `throughput-series.ts`, `throughput-account.ts`, `throughput-redact.ts` | host memory and CPU by class, repo and tenant; tests; series; each lead's wall time in seven places; the scorecard |
| Sessions | `GET /v1/sessions` | `read/sessions.ts` | the newest attempts, paged by `before` |
| Projects | `GET /v1/projects`, `/:name`, `/:name/setup`, `/:name/hygiene` | `read/project-index.ts`, `project-page.ts`, `project-setup.ts` | the Projects table, one project's page, its `project.yaml` as a form, its hygiene record |

Rules, one line each:
- Queue order (`orderQueue`, `domains/planning/queue.ts`): inside one project and `prio`, Issues sort by size, aged one size per `AGEING_STEP_MS`, then by the `factory-queue` order, then by number. Blockers and `prio` are never changed.
- Edges the factory added come back out when both Issues shipped with no shared path, or the blocker waited on the owner past `OWNER_WAIT_MS` (`domains/loops/edge-need.ts`). `checkQueue` (`domains/loops/queue.ts`) runs it through `removeInferredEdge` (`app/planning-chain.ts`), which keeps each removal in `factory.queue_edge_removals`.
- A kind of edge stops (`EDGE_STOP_MIN`, `EDGE_STOP_SHARE`, `kernel/edge-need.ts`) on the measure `readEdgeNeed` (`read/edge-need.ts`). A shared file is a proxy for need.
- Queue waits (`recordWaits`, `app/capacity-admit.ts`, `domains/capacity/waits.ts`): one interval per reason per Issue, kept `WAITS_KEEP_MS`.
- Lead wall time (`read/throughput-account.ts`): seven places, each taking only the time the earlier ones did not: owner, step, slot, merge lock, CI, turn, idle.
- Host signals (`host_samples`, `host_class_samples`, `host_process_samples`) are read in SQL and never kept as counters of their own; a lead sees work repos and tenants as `private`.
- Build minutes: CI runs come through `githubCiTimes` (`adapters/selfwatch/github.ts`); a repo whose CI cannot be read keeps its check figures under `build.unreadable`.
- The six capacity figures the ledger compares are `CAPACITY_FIGURE_KEYS` (`packages/contract/src/read-models.ts`).
## Tests

- **Unit** where logic is pure and dense: the machine, correlation, the gate, admission, the queue order.
- **Model test** of the machine.
- **Scenarios** (`tests/scenarios`): use cases end to end against a real server and Postgres with fake hc and agw. They
  are the acceptance suite, and a lead runs the ones its change touches as its proof.
- **E2E** (`tests/e2e`): Playwright against a seeded server, every Console screen at three viewports.
- `make check`: the whole gate, listed in `docs/operations.md` "Check tiers".

## The Console

`apps/console` is the owner's window (NL1): Vite, React, shadcn on Base UI, Tailwind 4 with Basalt's tokens, TanStack
Router, Query and Table, a PWA. `tests/e2e` (Playwright) holds its suite and the README's screenshots. The server's second
loopback listener serves the build, published by dotfiles-private's serve row (`docs/operations.md` "The Console
listener"). It is read-only apart from the fifteen verbs (eleven answers, pin and unpin, an account's mode), its perimeter is the tailnet ACL
(NL25), and it can never spawn a session. The screens are the ones of `apps/console/src/lib/screens.ts` (Overview,
Needs you, Chain, Projects, Artifacts, Improve, Throughput, Accounts) and the pages an Issue, a project, an artifact and a collection each have;
`/checkpoints/<id>`, the link of the owner's pages, lands on its item. `apps/console/README.md` describes each screen and
`apps/console/DESIGN.md` is the design bar.

- **The flow trend** (`GET /v1/flow/trend`, `factory read flow-trend`, `read/flow-trend.ts`): the four counts per bucket (running, paused, not started = ready plus held, checking; the trend is by stored state, so it cannot split ready from held), the peak (most Issues at any instant) and the time-weighted average, computed from the applied events' `to_state` intervals, never from samples: 24 hours by the hour, 7 days by the hour (the default), 30 days by the day, buckets on UTC hours and days; 7 days by the day and 30 days by the hour are refused. `FlowModel.trend` (eight daily samples, kept for the Herdr glance) stays; the Console's chart over time is this read.
## The throughput loop

**The throughput loop** (`tp-loop`; the measures are `GET /v1/throughput`'s and `read/throughput-loop.ts`'s, its ledger the throughput rows of `loop_findings`, `migrations/1061_loop_ledger.sql`; before it `throughput_findings`, `migrations/1027_throughput_findings.sql`). Measured costs only pay off when someone acts on the largest one and checks that it moved. Once a day, without a model, the loop ranks what cost most over the last 7 days, in minutes of the host's capacity: a project's slot-minutes of failed `factory slot run` steps (`failed_run_minutes`, a per-day figure); slot-minutes per Issue closed `done` when it is 25% above the median of the same ratio per day over the 14 days before (`slot_minutes_per_issue`, cost the excess times the Issues closed); a step tier whose 90th percentile peak memory is over the project's `budgets.peak` (2 GiB when it sets none), cost the minutes of the runs over it (`step_peak_mib`); a process (not `postgres`, `SHARED_MEMORY_PROGRAMS`, not `kernel_task`, `isKernelTask`, not `XProtectRemediator*`, `isTransientScanner`, and not of the tenant class, which `tenant_growth_mib` below reads) whose footprint grew by 1 GiB or more between its first and last notable minute, cost its notable minutes, on the repo it belongs to or on software-factory (`process_growth_mib`); and the minutes queued Issues waited, one candidate per binding reason read from the queue intervals (`queued_minutes`, the subject the reason; "What the queue waits for" above): `memory` (interval kinds `memory` and `memory_fit`, the label names the share of the lead-fit refusal) and `account` (`window`, `cap`) are filed on software-factory with the repos they hit most, `claim` and `lane` on the repo whose Issues waited, naming its `leads` and the lanes (with their caps) its Issues waited in (`WAIT_SUBJECTS`, `waitFacts` in `read/throughput-loop.ts`). A wait behind an `after` edge, a stopped line, a Spec at the owner, a drain, the boot grace or the load is not ranked (the parts of `queue_wait_p90` in `factory read kpis` are the cut between an `after` edge and capacity, and `queueByReason` shows every kind). A finding filed before the reasons were recorded (subject `*`) is `unmeasured` at its after. A cost under 30 minutes is not a finding. A cost the newest 3 days already left behind (its figure over them is at or under the target: fixed days ago, or a burst that ended) is not filed, though it still sits in the 7-day total; a figure those days cannot give (no run, no closed Issue) says nothing and the candidate stands. Two findings read the tenant class (launchd jobs and VMs) from the hourly rollups `host_class_hours` (complete hours; a cluster's shared mapping is counted once, as the class rows store it), both filed on the repo that owns the host's configuration (`DEFAULT_TENANT_PROJECT`, `dotfiles`) because a tenant is a job or VM no project's lead can shrink: `tenant_class_mib`, the class's mean footprint over the 7 days above its budget (`DEFAULT_TENANT_BUDGET_MIB`, 6144, what the dotfiles program aims at with its work profile up; target the budget), filed with the three largest tenants and their figures; and `tenant_growth_mib`, a tenant whose mean over the newest 24 hours is 1 GiB or more above its own median of the 14 days (24-hour buckets of sampled hours, an absent tenant counting 0, at least 7 buckets or no median) before them, which needs no budget and no list of tenants and catches a VM left on (subject the tenant, target that median). The excess is turned into minutes as slot-minutes: the excess over 2048 MiB (one test slot's default step budget) times the minutes it was held, the 7 days for the class and 24 hours for a tenant, so standing memory ranks against the other costs. The after of both is the same mean over the 3 days past the ship. They hold the repo like any finding: one open at a time. Only the class kinds read a budget: the other classes have none (the Console's Throughput page shows each class's share, and the pressure level and swap carry the state); `GET /v1/throughput` carries `host.tenantBudget` (the budget, the window's tenant footprint, `over`). Per project, with no improvement open, the largest cost that no finding holds is filed as a signal on the project's repo (`agent:<project>`): the measured before in the figure's unit, a target (half of a time figure; the median for the per-Issue ratio; the peak budget for a step), the query that reads it again, and the retro marker (`Retro: <date> kpi=<kpi> before=<n> direction=down`) as its last words, so the weekly retro's ledger lists it. At most 5 a pass. A project holds one open improvement: while a finding's Issue is not shipped, nothing else is filed for it.

**A binding cap and the disk fit** (NL48; `domains/loops/caps.ts`, `read/cap-facts.ts`, `domains/capacity/disk.ts`). A repo's `leads` or a lane cap is a claim about a resource, and the throughput pass checks it beside the ranking: when an Issue of the repo was queued for `claim` (or `lane`) in at least 60 minutes of the last 24 hours in which an account seat was idle (`host_samples.seats` over `leads`) and the cap is still below the default, it files one signal on the repo (`The lead cap \`leads: N\` of <repo> binds while seats idle`; the cap and the repo are its finding key, so one open signal per cap) with the cap, the comment beside it in the default branch's `project.yaml` (`capComment` of `@software-factory/project-lint`) and the figures for the resource the comment names (`capReasonOf` in `contract/project`: disk, merge windows, a lead's memory); the repo's `queued_minutes` finding for the same wait is not filed beside it. Disk is not a cap: the host loop measures each running attempt's worktree with its build output (`du -sk`, at most every 10 minutes per worktree and 3 per pass, `factory.worktree_sizes`, `migrations/1055_worktree_sizes.sql`) and admission refuses a lead as `disk` when the repo's learned footprint (p80 of the newest ten attempts, at least three) does not fit the home volume's free disk less the headroom (10 GiB or 5 %) and the footprints of leads started in the last 10 minutes (`diskRefusal`; `HostReader.disk`, `statfs`). With no lead running, no learned size or no reading it keeps nobody out.

The **ledger** is the table: a row per filing (`open`), marked `shipped` with the ship's time once its Issue shipped, or `dropped` when it closed without a ship (the subject is left out for 14 days). Three days after the ship the loop reads the same figure over `[shipped, shipped + 3 days)` (`figureOf`, the same SQL as the ranking, so a figure is read one way) and stores the `after`: `moved` when it fell by 10% of the before or more, `flat` or `worse` otherwise, `unmeasured` when the window has no run, Issue or step of the subject. A finding that moved is held out of the ranking until the 7-day window has left the days before its ship; one that did not move is ranked again at once and filed with the earlier attempt named (`reopens` is that row), because its cost is still there. The weekly retro's ledger (`read/retro.ts`, `ledgerOf`) joins the table by signal: its `now` is the loop's own after and its `measured` is `after`. A reading that fails (the database, a slow query) is a note in the pass and leaves the row for the next day.

`budgets:` in `project.yaml` (`{ fast: 90s, peak: 2GiB, fail: 10% }`, each optional, a duration, a size, a share; `budgetsOf` in `packages/contract/src/project-file.ts`) makes a breach a signal the day it happens (`fail` the second day in a row, a red `check-fast` not counted), through the `selfwatch` loop above, not the daily pass. `peak` is also the step target of the daily ranking.

## Not built

- **The 30-minute forward** (NL5): an unsolved alert reaching the owner. The old core's `FACTORY_ALERT_*` settings are gone from
  the env allow-list; the server reads none of them.
- **A per-request identity on the Console listener:** accepted (NL25). The tailnet ACL is the perimeter; see "Perimeter".
- **Client work in other repos:** Argo's factory pages leaving for the Console; Iris rendering an artifact inside it.

