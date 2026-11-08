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
  cli/        `factory`: commands generated from the OpenAPI document, plus the hook, slot, deploy-lock, follow and role verbs
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
  adapters/      postgres stores, hc terminals, agw, git, ntfy, filesystem blobs, the intake pollers, the hook socket
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
- **Model test** (`apps/server/test/work/model.test.ts`): a seeded generator plays random event sequences and checks
  invariants: a machine wait always has an exit that needs no person; a wait on the owner always states what it holds; a
  closed Issue reopens only by its verb, within 30 days.
- No XState, no workflow engine. Events in Postgres plus a row version are the whole mechanism (NL11).

## Signals and triage

Every input is one envelope (`source`, `kind`, `origin`, `trust`, `repo`, `fingerprint`, `title`, `text`, `link`) and goes
through `receive` in `app/intake.ts`; the answer is a triage outcome (`docs/language.md`).

- **Sources.** The owner (`factory signal`, Hermes through the narrow `signal` caller as `owner:hermes`), agents
  (`agent:<repo>`), the alert door (Kuma and HyperDX), and three pollers: GitHub (the owner's new issues and failing
  checks; anyone else's need the label and are held), Beszel (host rules from `config/infra.json`) and launchd (a
  LaunchAgent's state). `repo` comes from the route, the door registry or the caller, never from an outside payload.
  **App feedback** is a door source of its own: `POST /feedback/<app>` with the app's token (`feedback-<app>` in the door's
  tokens file) becomes `POST /signals/feedback`, one envelope for every app (`FeedbackRequest`: app, version, route, title,
  text, link). It is a signal from `feedback:<app>`, trust `outside`, whose text opens with an `app/version/route` header;
  the repo is the door route `(feedback, <app>)` or none, and the fingerprint is the repo (or app) and the title, never the
  version or route, so one complaint from two builds is one.
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
  (`drain` starts nothing), the host's 1-minute load, its memory (swapouts and swap against ceilings), the repo's claims
  (`leads: N` plus one for a fix; `pace` allows one), then an account with room. The first that says no names itself and
  its numbers as the queue reason. It never spills to another account past a window or a cap; with every account closed it
  waits for the first opening. Owed Issues are served before new ones.
- **The quiet lead** (`nudgeIdle` in `app/loops/steward.ts`, `decideIdle` in `domains/loops/stall.ts`). A `working` Issue is
  no stall, so the steward reads each one's lead session (`deriveSession`: `idleSince` is the end of its last turn). A
  turn that ended with nothing reported since it began, in a live terminal, for `FACTORY_STEWARD_IDLE_MS` (20 minutes),
  gets a `noted` event by the steward that names the Issue's last event (a regression, a note) and tells the lead to
  check its background tasks and report. A session mid-turn, whatever a tool in it is doing, is never read. The wakes are
  counted from the events alone (steward notes that begin with `IDLE_NOTE`), `maxWakes` per attempt and each after another
  threshold of quiet; after that `factory-steward` is asked as for an `unreported` stall. Its `wake` is one more such
  note; its `raise_decision` first stalls the Issue as `unreported` (a Decision is only raised from a stall), then raises it.
- **The claim deadlock** (`breakClaimDeadlocks` in `app/loops/steward.ts`). A working or watching Issue keeps its repo's
  claim; when it is after an Issue of the same repo that stays queued for lack of a claim, neither can move. The edge gets
  there by the owner (or the orchestrator on his behalf) naming it with `after` (`POST /planning/after`, which takes a
  working or watching Issue too). Each steward pass takes the queue's `claim` refusals, reads the holders with an open
  planning edge to one of them (`read/loops.ts`), and defers each: a `noted` and a `deferred` event by the steward, the
  reason in the `deferred` payload (`why`). The dependency wait frees the claim and the blocker is admitted; when it
  closes, the wake (`wakeDependents`) sends the holder back and it is counted as owed, served before new leads. One that
  had shipped goes back to `watching` with a new watch (the old one ends). Only open planning edges are read, never free
  text: a lead or an in-session subagent that merely mentions another Issue is not detected, and a blocker queued for any
  other reason (load, memory, window, chain) or in another repo is left alone.
- **The timer wake** (`wakeTimers` in `app/planning-pass.ts`). Every planning pass wakes each timer wait whose `until`
  has passed, as `wakeDependents` does for dependency waits: a `woken` event by the factory, keyed by the wait's version,
  so a replayed pass wakes once and a wait overdue by days ends on the first pass.
- **Start** (`app/leads-start.ts`): claim and look, make the worktree (`factory/<issue>-<attempt>`), then the terminal,
  then record the lead started. The terminal is found by its `factory.key` label before one is made, so a replay after a
  crash attaches to the lead that runs. The prompt is the brief (`domains/leads/brief.ts`): standing orders that are
  byte-identical in every brief so the prompt cache serves them, then the Issue as filed, its facts and its notes.
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
  the transcripts are archived, the worktree and branch are removed when clean.
- **Test slots** (`domains/capacity/slots.ts`): a host-wide semaphore around `make test`, so parallel checks do not pile
  their load; `factory slot run` takes a slot, a wait past 45 minutes exits 75 without running, and a server that is down
  runs the tests anyway.

## Quality

- **Ship** (`app/quality-ship.ts`, `domains/quality/gate.ts`): the lead names merged commits; git must find them on the
  default branch, read by the factory, never taken from the lead. Without that the ship is refused with the error named and
  counted as friction. A review is recorded as evidence when agw's ledger covers the range, and its absence is recorded
  with its reason; it never refuses a ship (NL23). `evidence.ts` decides whether the paths deploy at all; its inert paths
  equal `scripts/verify.sh`'s.
- **Watch and verify** (`domains/quality/watch.ts`, `app/quality-watch.ts`): the project's `make verify` and probes run on
  their own loop, so a slow verify never holds the leads' pass. What the watch runs is the synced `project.yaml`
  (`app/quality-projects.ts`): deploy mode, `hold` as the window, `make verify` from a target, URL targets and probes. Only
  mode `make` reads `make version`; a missing version target there is red. A file with no target leaves verify to the
  Makefile, and a repo without a `project.yaml` is read from its Makefile alone (`adapters/quality/projects.ts`). A red check is retried with a doubling delay before it is
  a regression; a regression returns the Issue to its lead, twice, then it stalls. A checkout that cannot be read is
  rechecked, never passed.
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
withdrawn Decision is never amended. An Errand passes a screen before it reaches the owner, in order: deterministic rules
(`screenByRule`: a command a token can run and no hands word), then `factory-errand`, then the owner. The Issue waits from
the raise, but the owner is not paged and the Errand is not in Needs or the human queue until `errands.reached_owner_at`
is set. A turn-away ends the Issue's errand wait with `errand_done` (actor `factory` for a rule, `judge` for the workflow,
payload `turnedAway`: the reason), sets the Errand done with the reason as its note, and the lead hears it as its next turn.
A failed or refused call is tried again after the Judge's 5-minute backoff, three tries in all (`errands.screen_tries`);
after the third the Errand reaches the owner unscreened (`screen_by` `failed`). A Concept or Spec is a
revisable artifact; the owner's verdict arrives as the lead's next turn. Revisions are blobs under the data directory
named by their hash, never in git. The owner's line (ntfy) carries one page per checkpoint and nothing else.

The Console shows an artifact at `/artifacts/<id>` (`?revision=n`, `&compare=m` for two revisions side by side): the
kind and format in words, the verdict state, a revision selector, the comments with "General" (a comment on the whole
artifact hangs on the title with the path `global`) and "Unanchored" as their own groups, and for a Concept or Spec the
verdict control. The owner marks text and comments on it; the page posts the quote (the selection with its whitespace
folded, which is what the API anchors on) and the nearest heading path, and highlights the anchored comments with the CSS
Custom Highlight API. Markdown renders through react-markdown without raw HTML, with unsafe URLs refused and no image
loaded; HTML renders in an `<iframe sandbox="allow-scripts" src="/frame.html">`: a separate document the Console listener serves
under its own CSP (no request can leave it, and unlike a `srcdoc` frame it does not inherit the page's policy, which keeps
`script-src 'self'`). The page sends the artifact to the frame by `postMessage`; the injected annotator posts selections
back, and the page believes only its own frame's well-formed messages. Templates for a lead are in `apps/console/templates/`.

## Loops and agw

A loop is a named tick (`app/loops/runner.ts`) with a trigger (an interval, or a kick when something changed), a budget
and single-flight passes. Its deterministic part runs in the server; its judgment is a dedicated agw workflow with its
own prompt, tools and skills (`agent-workflows`), called through the agw port with a 30-minute hang guard. A call is
recorded in `loop_calls` under its key, so the next boot takes it up again.

| Loop | Deterministic | agw workflow |
|-|-|-|
| `leads` | spool replay, start, notes, finalize, the outbox | none |
| `planning` | read projects, file plan rows whose `after` rows closed, mark the chain, wake dependency waits and timer waits whose time has come | none |
| `watch` | verify and probes | none |
| `settle`, `send` | Decision steps, unscreened Errands, pages | `factory-ask` (the Judge); `factory-errand` (the Errand screen): stdin `ErrandScreenRequest` `{ errand: { id, summary, detail\|null }, issue: { id, repo, title, kind } }` labelled untrusted data; stdout `ErrandScreenAnswer` `{ verdict: pass\|turn_away, reason (1..300) }`; call key `factory-errand:<errand>:<try>` |
| `steward` | wake, re-check, requeue, deliver (`domains/loops/stall.ts`), nudge a quiet lead, note a watch whose checkout stays blocked, break a claim deadlock; while a project has a live lead, read its main checkout once a pass from local refs (`domains/loops/checkout.ts`): off the default branch or with tracked uncommitted changes, it is one note to each live lead (once per branch state and clean/dirty) and a `main-checkout` health line, no model | `factory-steward`: what a stalled Issue needs when the rules do not say |
| `triage` | fingerprint, routes, correlation window | `factory-triage`: kind, amend-or-new-or-already-settled (open and last-day closed Issues), likely `after` edges |
| `queue` | per repo: cycles in the chain, the queued Issues that wait for nothing (an ask needs two), the queue's shape (asked once per shape; an edge the loop added is part of it), a budget (one ask per repo per `FACTORY_QUEUE_GAP_MS`, three repos a pass), the edges checked and added through planning (never against the owner's `prio`) | `factory-queue`: `after` edges and a tie-break order; the order is recorded in `queue_asks`, never applied |
| `friction` | the week's counts (`read/friction.ts`), cut at the newest import (`import_issues.imported_at`: the old core's history is never counted), against the rules in `domains/loops/friction.ts`: a rate per Issue closed with a minimum sample of 10 closed, or a bare count for the serious patterns (stall, lead lost, undelivered note, regression); retired mechanisms (the review gate, NL23) are skipped. One signal per pattern over its rule, 5 at most, filed on this repo through intake with the evidence Issues; a pattern whose Issue is open amends it with a note (intake's fingerprint). Due once a week, read from `friction_passes` | none |
| `hygiene` | one project a tick (those with a `project.yaml`; `FACTORY_HYGIENE_REPOS` narrows): a throwaway checkout of the default branch swept by the probes (`check`, `links`, `retired`, `deps`, `cochange`, `adapters/hygiene/`), due again after `FACTORY_HYGIENE_EVERY_MS` (a week), read from `hygiene_passes`; at most 5 signals a project and pass, probe findings ranked in probe order and limited to 3, the rest named in `over_budget`; filed through intake as the project's own agent; a project whose `make check` needs a lab this host lacks says `hygiene: { check: false, reason: … }` in `project.yaml` and the `check` probe is skipped, the reason in its run detail | `factory-hygiene`: the stale and recently edited documents read against the code, at most the budget left (2 at least); its title is built from the kind and the path, so the same document is one pattern for intake; a failed ask is retried at the stored commit every `FACTORY_HYGIENE_RETRY_MS`, 3 attempts at most |
| `screen` | up to 10 held signals not yet screened (oldest first, `intake_signals.screened_at` null, `screen_attempts` under 5, `screen_retry_at` due), one call each, outside any transaction; the answer is checked before anything is done (`domains/intake/screen.ts`): a promote needs a known non-work repo (the signal's own, else the one named), a duplicate must be an open Issue of the repo it was shown, else the verdict becomes `leave` with a note; then `promote` or `dismiss` as `judge` (each looks at the state again: an owner who acted first is counted, not an error). A failed, unparseable or timed-out call (a missing workflow too) leaves the signal held and records the attempt with a backoff of `min(10 min * 2^n, 6 h)`; the pass still ends ok and its summary says `screen workflow unavailable` when every call failed | `factory-screen`: stdin `ScreenRequest` `{ signal: { id, source, kind, origin, repo, title, text, link, receivedAt }, openIssues: [{ id, title, kind, state }] (open Issues of `signal.repo`, at most 40, empty with no repo), projects: [name] (known projects that are not work repos) }` with title and text scrubbed and labelled untrusted data; stdout `ScreenAnswer` `{ verdict: promote\|dismiss\|leave, reason (1..300), repo\|null, duplicateOf\|null, recommendation (<=300)\|null }`; call key `screen:<signal>:<attempt>` |

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
  deploy-lock, follow and role verbs are hand-written where their contracts demand it. Commands of the old CLI answer with
  the way to the same thing (`apps/cli/src/retired.ts`).
- **Callers and tokens.** The caller is decided by the bearer token alone: `owner` (`FACTORY_TOKEN`, required), `orchestrator`
  (`FACTORY_ORCHESTRATOR_TOKEN`), `agent` (a lead), `machine` (the door), `signal` (Hermes) and `read`; every other token is
  optional, all differ, and a caller whose token is unset does not exist. The orchestrator, the owner's delegate agent, is on
  every owner row except the six that are the owner's own judgment or hands (a Decision's worth-asking flag, an artifact's
  verdict and annotations, an Errand done, a held signal's promote and dismiss). Its events carry the actor `orchestrator` and a Decision it answers is settled by
  `orchestrator`, so the owner-touch counts (`read/kpis.ts` `ownerTouch`) read the owner alone and its steering is the friction
  group `orchestrator_steer` (`steer:*`). A lead hears its note exactly as the owner's. Rows from before the token (the owner's
  actor with `via: orchestrator`) count as steering too.
- **One contract** in `packages/contract` builds every body; a body that does not parse is exit 9.
- **Reads** (`/v1/*`, `read/`): needs, flow, chain, Issues, sessions, signals, accounts, queue, loops, friction, finding classes, kpis and
  the change stream. Health lines (`read/lines.ts`) are kinds `door`, `account`, `loop`, `checkout` (a blocked watch) and `main-checkout` (a shared main checkout off its branch or dirty under a live lead). The stream (`read/stream.ts`) resumes from an opaque cursor without losing or doubling a change.
  `GET /health` carries the heartbeat.
- The hook socket is a plain `Bun.serve` unix listener beside the API: its contract (mode 0600, empty stdout) is the
  hook's, not the API's.

## Perimeter

The API stays loopback. The door and the Console are published on the tailnet by dotfiles-private's `tailscale serve`
rows (the Console on :8797, to its loopback listener), and the perimeter is the tailnet ACL by device tag (a grant of
`tag:mac` and `tag:phone` to `tag:devhost` on tcp:8797), as Collie's (NL25); the deploy publishes nothing. There is no
per-request identity: anything that reaches :8797 reads what the owner reads, and no more than reads and the six answer
verbs below, never a session start. The door holds only its own token; the orchestrator's is the owner's rights minus six owner-only routes, and the Console proxy never uses it. Nothing that can start Claude Code is reachable from
another node. The Console listener reads, and forwards exactly the owner's six answer verbs (a Decision's answer, an artifact's verdict
and annotation, an Errand done, a held signal promoted or dismissed), guarded against a cross-site page (JSON only, no cross-site fetch
metadata, no foreign `origin`, 64 KiB); it starts no session and cancels or reopens no Issue, and promote files one only
from a signal already held and dismiss files nothing. The artifact frame (`/frame.html`, `/frame/*`) is the one document the page frames and is
served under its own CSP (scripts, no network, sandboxed), not the page's, whose `script-src` stays `'self'`.

## Data

One database, schema `factory`; migrations apply under an advisory lock and a checksum. The cutover imported Issues,
events, decisions and evidence from the old schema (`apps/server/scripts/import/`, `docs/rewrite/cutover-runbook.md`), so
the KPIs keep their history. Usage and cost come from the `usage` schema by join, never copied.

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
  it is read-only apart from the six answer verbs, its perimeter is the tailnet ACL (NL25), and it can never spawn a session. The shell and Needs you (the answers
  in place; `/checkpoints/<id>`, the link of the owner's pages, lands on its item) the Flow board, the read-only Issue page (`/issues/<n>`, linked from a Needs you card) and the Chain are built; the other screens are not.
- **The 30-minute forward** (NL5): an unsolved alert reaching the owner. The old core's `FACTORY_ALERT_*` settings stay in
  the env allow-list for a rollback and the new core reads none of them.
- **Client work** in other repos: the Herdr glance, Hermes' factory skill, Argo's factory pages leaving for the Console.
