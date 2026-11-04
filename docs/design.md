# Design

**TLDR.** One Bun server on the mini owns long-lived state in Postgres: sessions, the queue, capacity, later
Issues. Interactive Claude Code in herdr-core terminals does all the thinking; `agw` workflows do every model call the
factory needs; plain code does the rest. Hooks report what sessions do as facts, the server derives state from
those facts when read, and every effect carries a deterministic key, so a replay never spawns, types or posts
twice. The fleet layer (§3) ships first and carries today's `/wave`. The Issue machine (§4) sits on top of it.

**This page wins over TDD v2.4 wherever they disagree.** The reasons behind each choice are in `docs/decisions.md`,
the build order is in `docs/program.md`. The code is plain TypeScript and zod (SF6).

## 1. Principles

A design choice that breaks one is wrong.

1. **The factory runs the lifecycle; Claude Code does the thinking.** What a script can decide, a script
   decides. Routine words and judgments (same symptom? which project? how big?) are `agw` workflows. Anything
   that needs understanding a problem or code goes to a lead.
2. **The factory never calls a model.** No SDK, no key. `agw` is its only model path, called like any client.
3. **Max reasons about code, API tokens do the routine.** Claude Code on the Max accounts is the only thing that
   diagnoses or changes a repo. A full pool means waiting, never spilling.
4. **Hand over the problem, not a conclusion.** A brief holds facts, evidence and verified history, never a
   cheaper model's guess at the cause.
5. **One lifecycle, no side doors.** Every piece of work enters as an Issue and leaves with evidence or a stated
   reason. Until F2, a wave is the unit and the same rule applies to its close-out.
6. **Facts are stored, state is derived.** The one stored exception: an Issue's lifecycle state (§4), written by
   one module with an event per transition. Liveness ("working", "stuck", "walled") is always computed on read.
7. **Done means observed in production.** A lead's "done" is a claim. The evidence and the factory's own
   `make verify` after the hold are the proof. Wrong in production means fix forward.
8. **A self-improving platform, as code.** A fix verified twice becomes a runbook or a job check. Rules, probes,
   thresholds and prompts live in repos and change through an Issue with evidence, the factory's own included.
9. **The owner decides business, nothing else.** Product direction, spend, irreversible data loss, other people,
   plus security policy. Anything else that reaches the owner is a defect. Everything written for the owner is
   short, verdict-first and free of internal names.

Fixed boundaries:

- **Network:** no public endpoint. The tailnet plus the owner's GitHub user is the security boundary.
- **Liveness:** no turn limits and no wall-clock ceilings on a lead. The stall rule (§6) is the one liveness rule.
- **Scope:** `~/SourceRoot` only; IuRoot stays outside.
- **Instructions:** `AGENTS.md` only, no `CLAUDE.md` in any repo.

## 2. Shape of the system

```mermaid
flowchart TB
  subgraph mini[Mac mini]
    S[factory server<br/>Bun, LaunchAgent, loopback HTTP]
    PG[(Postgres 18<br/>shared: factory, usage, argo)]
    AGW[agw host]
    H[herdr<br/>interactive Claude Code]
    CLI[factory CLI, rd]
    HK[hooks + spool]
    A[Argo API]
    S --- PG
    A --- PG
    S -- agw CLI --> AGW
    S -- Runner port --> H
    H --> HK
    HK --> S
    CLI --> S
  end
  IR[iris app] --> S
  HM[Hermes] --> S
  A -- intents --> S
```

- **One process.** A LaunchAgent, deployed like agw: release directories, health check, rollback of its own
  release. A Postgres advisory lock makes a second copy exit. Running sessions never notice a restart; they live
  in herdr, and their hooks spool what the server cannot take.
- **The database.** One database named `shared` on the mini's Postgres 18, a schema per writer (`factory`,
  `usage`, `argo`). agw keeps `agent_workflows` and grants read-only roles. F1 does not wait for A1, so whichever
  ships first creates the database, idempotently, through a target both repos can run.
- **API.** Loopback HTTP. One schema defines each operation, and both the HTTP route and the CLI verb come from
  it, as in agw's capabilities. Reads for dashboards are views in the `factory` schema; live updates are
  `LISTEN/NOTIFY`. Writes from any surface are intents through the API, never direct table writes.
- **CLI.** agw's contract (`--format json|plain`, data on stdout, messages on stderr, the same exit codes, never
  prompts). The block agents see stays small: `factory status`, `factory issue …`, `factory session …`,
  `factory project check`. The rest exists for the owner, the orchestrator and Argo, documented once.
- **Ticks and wake-ups.** `NOTIFY` wakes the worker on a new row; a tick every 5 seconds catches the rest and
  handles deadlines. `issues.wake_at` is the one Issue timer; `resume_at` on a spawn request is the fleet's.
- **Effects.** Each outside effect goes through a port (`Runner`, `Agw`, `GitHub`, `Notify`) and has a key
  recorded before it happens. A replay finds the key and stops.
- **Every start reconciles.** Before any effect: replay the spool, then look at the world once (herdr, worktrees,
  GitHub) for each open session and Issue. Open deadlines move by the downtime. Missed job slots run once. There
  is no separate adopt mode.
- **Dependencies point one way.** factory → agw, herdr-core, GitHub, the intake sources. agw never knows the factory.
  `rd` and the account picker stay in dotfiles and become clients or adapters (§3).

## 3. The fleet layer (F1)

Deterministic babysitting of the sessions `/wave` and `rd` start today. It replaces `wave-watch.sh`,
`fleet-keepalive.sh` and the Hermes babysitter cron (FL8). Issues do not exist yet at this layer, and the layer
does not need them: `issue_id` on a session is nullable.

### Sessions and events

A **session** is one Claude Code process the factory or `rd` started, identified by its Claude session id, with
its pane, worktree, repo, role, account, model, effort and parent. `rd` sets `FACTORY_SESSION` at spawn; without
it every hook exits at once, so the owner's own sessions never see them. Hooks are installed for every account's
config directory.

| Hook | Event | Used for |
|-|-|-|
| `SessionStart` | `session_started` (with the matcher: `startup`, `resume`, `compact`, `fork`) | binds session id and transcript path to the spawn |
| `UserPromptSubmit` | `turn_started` | prompt delivery proof, "no new turn" in the watchdog |
| `Stop` | `turn_ended` | turn boundaries; the send-back rule |
| `StopFailure rate_limit` | `limit_stop` | the resume watchdog |
| `Notification quota_auto_resume_*` | `quota_resume` (`fired`, `stale`, `disabled`) | the resume watchdog |
| `Notification permission_prompt`, `idle_prompt` | `prompt_blocked`, `prompt_idle` | blocked sessions |
| `SessionEnd` | `session_ended` | closes the session |

`UserPromptSubmit` is an addition to FL5's list: a turn's start is the only proof that a typed prompt arrived.

**The hook never blocks a session.** It appends the event to a spool file first, then posts with a 300 ms
timeout, and exits. `SessionEnd` has a 1.5-second budget, so the append is the part that must fit. The server
replays the spool on start and on each tick. The key is session id plus event name plus turn number.

The runner (herdr-core) is the backstop for what hooks cannot show. A tool call in progress produces no hook event, so
silence alone proves nothing; `stuck` needs the runner's agent status and the worktree's activity too. The witness follows
the core's event stream (a status shows at once, a lost or finished terminal asks for a pass) and runs a pass every minute
from that cache; it records the server identity (core pid and id; a change is a runner restart, an event) and the account
in effect, and reports dead panes.

### Derived session state

| State | Read from |
|-|-|
| `starting` | spawn recorded, no hook has spoken |
| `working` | latest `turn_started` has no `turn_ended` after it |
| `idle` | latest event is `turn_ended`, or `session_started` with no turn yet; no open wait |
| `waiting` | a declared wait is open (`factory session wait --on workers\|deploy\|owner`); `--done` or a delivered wake ends it |
| `walled` | a `limit_stop` or `quota_resume` with no later `turn_started`; a turn that ends after `quota_resume` fired stays `walled` |
| `blocked` | `prompt_blocked` with no later `turn_started` or `turn_ended` |
| `stuck` | `working`, the runner agrees, no commit or file change in the worktree for 45 minutes |
| `dead` | `session_ended`, or the pane is gone |

State reads from the latest `session_started`, so a resumed session starts clean. Hooks carry no token: they post
to a unix socket (mode 0600) and fall back to the spool. The socket serves the routes a session needs, not only events and waits (see "Hooks and the socket" below).

### The queue (FL1, FL3)

A **spawn request** is a row: repo, role, prompt, model and effort from the role table, a deterministic key, and
later the account, a `resume_at`, and the session it became. A spawn without capacity gets a `resume_at` and stays
in the table; nothing is dropped. The tick starts it when the time comes and admission says yes.

A key is spent when its spawn has ended. `ended` is derived at read time, never stored: the spawn is `started`, and its
session is `dead` or its pane is no terminal of the current core. Creating under a spent key is a `409 key_spent` that
carries the stored spawn; a live or queued key still answers 200 with its row. Reviving the row would start work a second
time, so the caller picks a new key (`rd`: `-r2`, `-r3`).

**Queue state** is `run`, `pace` or `drain`, set per scope: global, project, initiative. The most restrictive scope
that applies wins.

| State | Effect |
|-|-|
| `run` | admission decides |
| `pace` | lower concurrency; spends only toward weekly pace |
| `drain` | no new spawn. A running wave finishes its current wave; the chain stops at the boundary: its successor's spawn is held (`queued: drain`) and starts by itself when the drain lifts. Nothing is interrupted |

### Capacity and admission

- **Accounts come from the registry,** `dotfiles/config/claude-accounts.json`, never a constant. N accounts,
  today three. The picker stays in dotfiles; the factory calls `claude-account` through an adapter and stores
  each reading as a fact (`quota_readings`), so history survives and tests can inject a wall.
- **An account is eligible** if it is enabled, its auth is fine, and it keeps the owner's reserve: 15 % of the
  5-hour window and the last 5 % of the week, so new spawns stop at 95 %. A session already running there
  rotates at 94 % (below), one point earlier, so its successor can still be spawned elsewhere before the wall.
- **One active wave per repo,** across repos as many as capacity allows.
- **Never spill.** With every account walled the queue waits for the first reset.
- **A spawn holds its account** while queued or starting, and once started until a reading taken after its start
  shows it. A burst starts only as many spawns as there are open accounts; there is no per-spawn cost estimate. A
  spawn a rule holds back (`drain`, `pace`, one wave per repo, no capacity) stays queued with a hold reason.

### Rules that act

| Rule | Trigger | Action | Key |
|-|-|-|-|
| **Resume watchdog** (FL2) | a session is `walled`, its account's reset has passed, no new turn for 5 minutes | one delivery-checked "continue" | `resume:<session>:<reset_at>` |
| **Send-back** (FL5) | `Stop` with live child sessions and no declared wait, `stop_hook_active` false, the turn did not end on a limit | the hook exits 2 with one line | turn number |
| **Rotation** | a `mother` or `lead` session's account reaches 94 % of its week | one note: write the handoff and rotate; the next rotation lands on another account | `rotate:<session>:<week>` |
| **Folder trust** | any spawn | pre-trust the path before starting the agent, for new repos as well as worktrees | none, idempotent |
| **Blocked** | `blocked` for 2 minutes | a line in `factory status`, and to the session's parent if it has one | event id |
| **Wake** | a session `waiting` on its workers, with child sessions, none unfinished (`dead`, or `idle` after a turn; a spawn without a session yet is unfinished) | one note listing the children and their states; once a turn proves it, the wait it answers is cleared (unless a newer wait was declared) | `wake:<session>:<wait event id>` |
| **runner restart** | the server identity (core pid or id) changed | each affected session resumes by id, with a note that a turn was cut off; one the kept terminal's own resume (`hc-resume`) already brought back gets the note typed instead | `restart:<server>:<session>` |

The send-back counts only child sessions the factory knows. A background shell inside a session is invisible to
a hook; that gap stays until a measured failure says otherwise.

**The tick.** Four rules, each from a defect both spike arms shipped (`docs/spikes/2026-10-30-effect/verdict.md`):

- **Never call a port inside a transaction.** Claim the row and commit, call `Runner`, record the result in a new
  transaction. The key recorded at the claim is what makes a crash between the two safe.
- **Every port call has a timeout.** A hung `hc` must fail the call, not stall the tick.
- **Attempts are capped.** A spawn out of attempts is `failed` with a reason and leaves the batch, so it cannot starve
  the ones behind it. The tick loop itself survives any single failure and logs it.
- **Eligibility is rechecked at start,** not only when the spawn is queued. A stored account is a hint.

**Prompt delivery.** `factory session note` is the one way anything types into a session; `rd say` becomes this. The full behaviour is under "Prompt delivery" in *As built* below.

**One space per repo (FL6).** A space is keyed by path; a second space for the same path is explicit (`new_space`), for a separate plan or worktree; the full rules are under "Spaces (FL6)" in *As built* below.

**Test slots (FL7).** `factory slot run -- <cmd>` wraps `make check` and test runs in a host-wide semaphore: a
leased row, two slots to start and tuned from the load record, released on exit or lease expiry. It fails open: with the server down
or the wait over its limit, the command runs anyway, because a slot exists to reduce flakes and must never block
work.

**The role table (FL4).** One table for mother, lead, worker, mechanical and the subagent types, giving tier and
effort. `rd --role` and agent frontmatter read it; values move only on data from track U. Model ids stay in agw's
and dotfiles' route tables; this repo names tiers.

### `rd` becomes a client

`rd wave`, `fan`, `say` and `close` call the server when it answers and keep today's path when it does not. A dead
factory must never stop the waves that would repair it. The gate logic (`wave-gate.py`) stays until the server
covers each check. The verbs move under `factory` once F4 is running, and `rd` stays as an alias.

### As built

What runs today, moved here from `AGENTS.md`, which keeps the rules and points at this section. Where the design above and this section differ, this section is the code's behaviour.

#### The tick, retries and admission at the claim

**Never call a port inside a transaction.** The tick claims a row and commits, calls the `Runner` (every call has a
process timeout), records the result in a new transaction. A failing start is retried until a time budget from the
first claim (30 min, `FACTORY_RETRY_BUDGET_MS`), then `failed` with a logged reason; `factory spawn requeue <key>`
starts a failed spawn over. Admission is decided again at every claim except a reclaim (an expired lease: its agent may
already run, so it finishes on its account), and only due rows are selected
(`docs/design.md` §3, "The tick").

#### Spaces (FL6)

**One space per repo (FL6), keyed by path.** A spawn has a `space` (a path, default its `repo`, resolved like the repo and inside
the same roots, and containing the repo: 422 otherwise; `POST /spawns` takes `space` and `new_space`). The space is an id the
Runner puts in the label `herdr.space`: the entry of the Herdr app's document `herdr-app` whose `folder` is the resolved space
path (found by path, so two repos named `app` have two spaces and a worktree's `space` is its main checkout), else
`sp-<dir>-<12 hex of sha256 of the realpath>` (the full root is hashed, so `~/SourceRoot/x` and `~/IuRoot/x` differ). A second
spawn in a repo is a new tab in its space. `new_space: true` makes a second space for a path that already has one (the id also
hashes the key, so a retry makes the same); on a path with none it takes the first. **A space the factory names is seeded**
(`seedSpace`, `app-doc.ts`) in the app's document before the terminal runs, or the app adopts the label with `name: ""` and
the terminal's cwd as `folder` (a worktree, so the sidebar shows `w9-…` and the next spawn at the main checkout finds nothing):
`{ id, name: basename(space path), folder: space path, tabs: [] }` appended to `spaces[]`, compare-and-set on `version`, a
conflict reads again (3 tries), a value of null (never written) starts `{ spaces: [] }`. The path is the space's (the main
checkout for a worktree). A second space for a folder that already has an entry is named `<basename> <n>` (`app 2`). An entry
with the id is never touched, nor a document with no `spaces` array or with an entry that has no id (not the app's). Best effort like `nameTab`: a failure does not fail the
start, the id stays the label's, and the next start for that id seeds again. Not seeded: an id found in the document, a foreign
id with a terminal in it, a hidden child. The result names the terminal, the tab and
the space (`spawns.session|tab|workspace`; `Spawn.pane` is `session`). A try that fails reports its space
(`RunnerError.workspace`), the tick records it, and a retry or a runner-restart resume passes it back as `StartInput.workspace`:
it wins when it is an id the Runner made (`sp…`) or a live terminal is in it.

#### The runner

**The runner looks before it acts.** `HcRunner` (`hc-runner.ts`, herdr-core 0.1.15 over `hc connect`; `HcClient` in `hc.ts` is one
short-lived process per JSON-RPC call: `hello`, the request, stdin closed, the reply read by id, each under the process timeout
and the start budget, `childEnv()` stripping the factory's secrets; `HC_BIN`, and `HC_SESSION` for tests, pick the binary and the
core). Every terminal carries `factory.key=<spawn key>`: a live one running claude is never started again, only proven; a
finished one that reported, had a status or a turn is started (its prompt ran; a second run would repeat the work), one that never
reported, or a live one that is no longer claude (the shell the core puts in a kept terminal after a `kill -9`), is
killed if needed, `terminal.rm`'d and the spawn started afresh (a retry may be on another account); an error is a transient
`RunnerError`. Finding, placing and running go one at a time per runner (two starts never both take an empty space's id).
**The prompt is the last argument of the program** (`claude --dangerously-skip-permissions --model <tier> --effort <effort>
[--resume <id>] <prompt>`; a reviewer's is `… --effort <review.effort> --disallowed-tools <the writing tools, comma-separated> --agent reviewer <prompt>`, the
list-valued option before another option so it cannot swallow the prompt; `claude --resume <id> "<prompt>"` takes the id as the option's value), `cwd` is always the repo, `keep: true`, the
name an hc-valid `agentName`; so nothing is typed at start. The agent is started when `terminal.get` shows it reported (`reported`,
a status or `turn >= 1`) inside the deliver window (30 s). A terminal that is live but silent after the window is started, unconfirmed (the hooks and the witness confirm it later), never a failed start: a load-slow Claude Code is not a failure. A terminal that ended or cannot be read is a transient error. `claude-pretrust.sh` runs before every
spawn (a test pins that a path never seen before is trusted first). A prompt cannot start with `-`. The account is in the `env` of
`terminal.run` (`accountEnv`): `CLAUDE_CONFIG_DIR` only for a non-default account, never empty, never inherited, plus
`CLAUDE_ACCOUNT_PICKED`, `USAGE_LANE`, `FACTORY_SESSION`, `FACTORY_ROLE`.
Placement is by labels, no window needed: a **tab** (any role, or a worker whose parent session has no known terminal) has
`no_parent`, `herdr.space`, `herdr.tab` (`tb-<12 hex of sha256 of the key>`) and `factory.tab_name`; its entry in the app's
document is named after the key once the app has one (compare-and-set on `version`, `app-doc.ts`; the witness retries on a label
or document event). A **hidden child** is a spawn whose parent session has a terminal (`StartInput.parentTerminal`, the parent's `pane`), is not
`new_space`, and is placed `child`: by the caller's `placement` (`POST /spawns`, token and socket; `factory spawn create
--placement tab|child`; stored in `spawns.placement`, answered by `Spawn.placement`, part of the idempotent replay, which answers
the stored row), else by the role's default (`worker`/`mechanical`/`deep` child, every other role a tab). The caller says it
because the role cannot: a lead spawns both its waves (children) and its successor (a tab). Such a child is that terminal's
hidden child, whatever its role: `parent`, `outlive_parent`, `no_notify` (the factory wakes parents itself), no
labels but the key; its result has no tab (null) and the space of the nearest ancestor that has a `herdr.space` label (up to 8 hops, so a lead's wave under a mother has the mother's; null if none or unreadable); a resume of a child (`prompts.ts`) passes the parent session's current pane again, except for a `new_space` spawn; a parent
that is gone (`not_found`), or a `child` with no parent terminal at all, makes that try a tab. An older server drops an unknown
`placement` (the schema is not strict) and answers a row without it, so a client can tell by the missing field. The app's document is read for spaces: only a confirmed absence (`not_found`, never
written) falls back to a hashed id; a call that fails is an error for the retry. `type` reads `terminal.get` and sends only to `idle` (guarded with `if`) or `done`, otherwise `busy`; a core
refusal is nothing typed (`blocked` or a changed status: `busy`), a lost call is `UncertainTyping`. The doc shape of
`herdr-app` (`spaces[].{id, folder, tabs[].{id, name}}`) is read loosely; the live document (2026-11-01) confirms it.

**A hidden terminal** (`placement: hidden`, the role default of `reviewer`) is the third placement: `terminal.run` with `no_parent: true` and the single
label `factory.key=<spawn key>`: no `parent`, no `herdr.space`, no `herdr.tab`, no `factory.tab_name`, nothing seeded in the app's document and no tab named
(`StartResult.tab` and `workspace` are null). The key label is how the Runner finds and closes it (`Runner.close`). The params are herdr-core 0.1.15's
`terminal.run` (`no_parent`: "No parent, even when started from a terminal"); the terminal is **not kept** (`keep: false` for role `reviewer`), so `hc-resume` (which types `claude --resume` into kept terminals) never brings it back; whether the Herdr app shows an unlabelled, parentless terminal anywhere is the
app's choice and is not asserted here. A caller may ask for `hidden` on any role (`--placement hidden`); a reviewer accepts no other.

**A failed spawn leaves its terminal.** It is labelled with the key and `factory spawn requeue` finds it again (an agent already
running keeps the account it started on); closing it is a decision, not a side effect of `failed`. A finished terminal is
removed and made again on every try, so a retry on another account gets that account's environment.

#### The trust boundary

**Trust boundary.** The token can start Claude Code with `--dangerously-skip-permissions`, so a spawn's `repo` must be
inside an allow-listed root: `FACTORY_REPO_ROOTS` (colon-separated, default `$HOME/SourceRoot:$HOME/IuRoot`). The path
is resolved with `realpath` and must be strictly inside a resolved root, so neither `..` nor a symlink leaves it;
otherwise `POST /spawns` answers 422 and stores nothing (the row keeps the resolved path). Within the roots the token is
shell access as the mini user by design. The API is loopback only and the tailnet plus the owner's GitHub
user is the perimeter (`docs/design.md` §1). `FACTORY_REF=<branch>` runs whatever is on that origin branch with the
server's secrets, the same boundary; `make deploy` without it deploys `master`.

The factory door (§11) is on the same side of this line as a pane. It posts to the hook socket, which has no caller identity (SF11),
so a compromised door can call any route the socket serves: `POST /intake`, but also `POST /issues` and `POST /spawns`, which
starts Claude Code inside `FACTORY_REPO_ROOTS`, as any process of the mini user already can. Accepted, as SF11 accepted it for
panes; what the door lacks is the token, a database credential and the queue's writes. A socket of its own for `/intake` alone is
the change that would narrow it.

#### Hooks and the socket

**Hooks: spool first, then post.** `factory hook <event>` (session-start, user-prompt-submit, stop, stop-failure,
notification, session-end) does nothing without `FACTORY_SESSION` (set at spawn: the Runner puts the spawn key in the
pane's `--env`, `rd` its agent name). Otherwise it appends one line to `~/.local/share/factory/spool/<session>.jsonl`
(`FACTORY_SPOOL_DIR`, one `O_APPEND` write), posts it to the server's unix socket (`FACTORY_SOCKET`, default
`~/.local/share/factory/hook.sock`, 300 ms timeout) and exits 0 whatever happens, with one exception: the send-back
(below). The hook has no token and the Runner
keeps secrets out of the panes, so the socket (mode 0600, owner only) is its credential; the socket serves
`POST /events`, `POST /sessions/:id/wait` (`factory session wait`), `POST /sessions/:id/note` (`factory session note`),
`POST /sessions/:id/stop-check`, `PUT|DELETE /slots/:id` (`factory slot run`), `POST /spawns` (a pane starts work, below),
`POST /issues` and `GET /issues[/:id]` (a pane files work, §4), `POST /intake` (the door's alerts, §11), and
three reads a spawner needs to follow it, `GET /spawns/:key`, `GET /sessions/:id` and `GET /queue[?project=]` (`factory spawn get`,
`session get`, `queue get` use the socket when `FACTORY_TOKEN` is not set), which a session in a pane runs without a token, and
nothing else (not the spawn list, requeue, status, quota or any write to the queue); bound under umask 0177. Any session on it can note any other and file events for any other (the socket is the trust boundary and has no caller
identity; a same-user pane can already drive any terminal through hc, so this adds no capability, and it is a known and accepted
cross-session path); an event of
kind `runner_restarted` or `pane_gone`, or filed under `_runner`, is refused there and in the spool: only the witness records them. It imports nothing but `node:fs` and `@software-factory/contract/spool`: keep zod and
the rest of the CLI out of `src/hook.ts` (`bin/factory.ts` loads it alone). **Stdout stays empty for every event, and
stderr too except for a send-back**: Claude Code injects a SessionStart/UserPromptSubmit hook's stdout into the
session's context (tested per event). `session-start` also reports `CLAUDE_ACCOUNT_PICKED` as `account` (only if it is a name in the registry's alphabet, checked in the hook and again by the server), which is how
the factory knows the account of a session no spawn describes (`rd`'s); a spawn's own account wins.

#### Prompt delivery

**Prompt delivery** (`prompts.ts`) is the one way anything types into a session. `factory session note <session> <text>`
(`POST /sessions/:id/note`, socket or token; `--id` makes a repeated call one note) and every rule below record a row in
`factory.prompts` under its id first (`ON CONFLICT DO NOTHING`: the same id is one prompt). The tick types it through
`Runner.type` (`terminal.send`; `busy` while the runner says `working`) once the derived state is `idle`, `waiting` or
`walled`, so a `working`, `blocked`, `starting` or `dead` session holds it until its turn ends; the claim is committed
before the call and the result recorded after it. `sent` becomes `delivered` on the next `turn_started` after the claim.
No turn within a minute: Enter is pressed once more for a prompt whose typing was confirmed (`Runner.type` with `enterOnly`), otherwise the text is typed again; a resume is started again, `MAX_SENDS` 2, then `failed` with an `unconfirmed: ... not delivered` reason, which stays in `factory status` for
a day from when it failed. A Runner error that says nothing was typed is retried every 30 s, five times; one that cannot say
(`UncertainTyping`: hc timed out or died after the call) counts as sent and waits for a turn; the one retry after a
minute without one types the text again, as for a claim left `typing` by a crashed tick (after the start budget plus a minute): only
a prompt whose first typing the runner answered `typed` (`prompts.typed_at`, migration `030`) gets Enter alone, since only then is the text known to be in the pane.
`Runner.type` types only into an agent the core calls `idle` or `done` (`working` queues the text, `blocked` would answer its dialog). A `pending` prompt expires after 6 h
(a rule's) or 24 h (a note). A rule whose prompt failed or expired asks again after 30 min while its condition holds
(the same row starts over; a delivered prompt, a note, or a prompt recorded as undeliverable never does). One prompt is
typed per session per pass. A later prompt for a session waits while an earlier one is `typing` or `sent` and unproven. A retry is not typed if a turn has shown up since its claim; a `busy` answer clears the claim, so a later turn proves nothing. A prompt resumes a session only while it has shown no life since the prompt was recorded. Only
prompts that reach the Runner count against a tick's batch of 10. A note cannot start with `-` (it could read as a
flag) and cannot use a rule's id prefix (`resume:`, `rotate:`, `blocked:`, `wake:`, `restart:`), which would take the rule's place.
The blocked note names the worker but not its prompt text: that is agent-produced and stays in `factory status`.

#### Rules that act

**Rules that act** (`rules.ts`, run at the start of every tick after the spool replay and the quota poll; each records its
effect under a key, so a replay records nothing):
- *Resume watchdog* (FL2): a `walled` session whose account has a reading naming the wall's end (the first reading after
  the wall that carries one: `exhausted_until`, else the reset of each window at 95 % or more, the later; else the 5-hour
  reset), with 5 minutes passed since the later of that reset and the last wall event and no more than 6 hours (a wall
  older than that is history, so a deploy wakes nobody): a `continue` prompt, `resume:<session>:<reset_at>`. Needs the
  session's account.
- *Send-back* (FL5): on `Stop` the hook asks `POST /sessions/:id/stop-check` (300 ms) before it records anything: a stop that is
  sent back is no end, so it writes no `turn_ended` and the turn stays open (the session stays `working`, nothing is typed into
  it); a stop that is let through is spooled and posted as usual. The server
  answers `sendBack` when the session has live child sessions (sessions of spawns whose `parent` is it; `parent` comes
  from `POST /spawns`, `factory spawn create` defaults it to `FACTORY_SESSION`), no open wait, is not `walled`, and the
  hook says `stop_hook_active` is false; once per turn (`effects` key `sendback:<session>:<turn>`, recorded when the answer is given: an answer the hook
  cannot wait for, 300 ms, spends that turn's send-back). The hook then exits 2 with the one line on stderr. A server that is down, slow or odd means exit 0. A pane has no token and
  starts work through the socket (below), so the children of a session in a pane carry its `FACTORY_SESSION` as `parent`:
  the send-back sees them whoever started the pane.
- *Rotation*: role `mother` or `lead`, its account at 94 % of the week or more on a fresh reading: one note, `rotate:<session>:<week reset>`.
- *Blocked*: `blocked` for 2 minutes is a line in `factory status`; if the session has a live parent, also a note to it,
  `blocked:<event key>`.
- *Wake*: a session `waiting` with `--on workers`, with at least one child session and none unfinished, gets one note,
  `workers done: <child> <state>, …`, `wake:<session>:<the wait's declared event key>` (one per declared wait; a new wait
  can wake again). A child is finished when `dead` or `idle` after a turn of its current life (`liveSessions`' `finished`);
  a spawn of the session's that has no session yet (queued, held, waiting for capacity, starting) is not. A failed spawn
  does not hold the wake: it is a line in `factory status`. A parent that is not `waiting` gets nothing (send-back covers
  a working one). This is what resumes an orchestrator that ended its turn on a wait. **A delivered wake ends the wait it
  answers:** in the transaction that records the delivery (the `turn_started` that proves the note, in `settlePrompts` and
  in the retry path of `deliverPrompts`) the factory records a `wait_cleared` (key `<session>:wait_cleared:<prompt id>`,
  dated 1 ms before that turn's start, never before the wait it ends; the Stop hook's `stop-check` settles the session's own wake first), so the session reads `idle` when the woken turn ends and send-back sees no wait again; the
  orchestrator needs no `--done`. Only while the wake's wait is still the session's latest wait event: a `wait_declared`
  after it (the woken turn waits again) or a `--done` already there is left alone. At delivery, not at creation: until a
  turn proves the note the session stays `waiting` (true: it has not woken), and a wake that fails or expires clears
  nothing, so the rule can ask again after 30 min.
- *runner restart*: a `runner_restarted` event at least 3 minutes and at most 2 hours old: each session that had a turn open
  at that time, has had no hook event since and that the runner has not shown since is resumed by id (`Runner.start` with
  `resume`: `claude --resume <claude session id>` in a new tab on the spawn's account, the note as its first prompt),
  `restart:<new server identity>:<session>`. A resume starts an agent, so it is admitted like a spawn claim (held under
  `drain`, `pace` or a full account, only on the account the conversation lives in; the hold shows in the prompt's error) and
  reserves that account in the same locked transaction that admits it (given back if the start fails), so a spawn claim in between
  sees it taken. A restart prompt never re-arms. **One resumer per session:** `hc-resume` (dotfiles) types `claude --resume`
  into every kept terminal with the resume labels, factory spawns included, and types no prompt. A session whose only events since
  the cut-off turn are `session_started` with source `resume` (an idle notice may follow; no turn; the resume may precede the
  witness's `runner_restarted` by up to 2 minutes; a resume from an earlier restart does not count) was resumed in place: the same note is typed into it (`via: type`,
  the same id), nothing is started. A resume prompt recorded before that resume landed is turned into a typed one at delivery, so the
  factory never starts a second copy of a conversation something else resumed. `hc-resume` is not changed: skipping factory terminals
  would leave idle and waiting sessions (an orchestrator waiting on its workers) as a shell nobody resumes. A session that is not a factory spawn (or never reported its Claude session
  id) gets a `failed` prompt with the reason: that is its line in status.

#### `factory status`

**`factory status`** (`status.ts`, `GET /status`, token): attention lines (blocked 2+ minutes, stuck, walled, failed notes
and spawns, and the Issues' open questions, parks and failures), sessions not `dead` (walled, blocked, stuck, working, waiting, starting, idle), the queue with hold reasons,
the accounts' readings, a line `reviews: <live>/<slots> live, deep today <n>/<cap> per account (<account n>, …)` (`Status.reviews`; n is the most any one account has started since 00:00 UTC), the open Issues (§4 "Following an Issue": at most 40, the rest counted), prompts not delivered (failed first, at most 100, the rest counted as "N more not shown"). `--format plain` prints it as one screen.

#### The spool and the event key

**The key is session, event name, turn number** (`<session>:turn_ended:3`), counted from the spool, written into the
line, so a replay carries it. Counting and appending happen under a per-session lock (`<file>.lock`, a `mkdir`; the
server's rotation takes it too); a hook that cannot get it in 200 ms writes a key with a random suffix instead. A kind that repeats inside a turn gets `:2`, `:3`. Event time is strictly increasing per
session. `SpoolReplayer` (`spool.ts`) reads the directory at the start of every tick and stores whole lines past its
in-memory offset (a restart re-reads: the unique key makes it harmless). A quiet, fully read file over 64 KiB is
rotated: its sums (`turns`, current-turn counts) go to `<file>.base` first, so numbering never starts over, then the
file is retired. Spool files of dead sessions are kept (a reused `rd` name must not reuse keys). A rotation that died after moving the
file leaves `<file>.retired`; the next pass stores it and removes it. The lock holds a token, so a holder taken for
dead cannot release its successor's lock.

#### Derived state

**Derived state** (`sessions.ts`, first match wins; turns, walls and prompts count from the latest `session_started`):
`dead` (last of session_started / session_ended / pane_gone is not a start; a `pane_gone` is withdrawn by a later hook
event or by the runner showing the agent again), `starting` (the factory has the row, nothing proves it is up), `walled` (limit_stop or quota_resume with no
later turn_started; a turn that ends after `quota_resume fired` ends it too), `blocked` (prompt_blocked with no later
turn_started or turn_ended), `working` (open turn; `stuck` when the runner says working within 5 minutes and neither the
worktree nor the turn moved for 45 minutes), `waiting` (an open `factory session wait --on workers|deploy|owner`, no
open turn; the wait ends with `--done` or when a delivered wake answers it), `idle`. Events are ordered by event time, then arrival. Only `limit_stop` from `StopFailure rate_limit`
is a wall; other stop failures are ignored.

#### Sessions

**`factory.sessions` is what the factory follows; `usage` owns the session entity.** Row id = `FACTORY_SESSION`; a spawn
gets its row when the tick claims it (`starting` until its first event; the pane is added when the Runner returns it; a
spawn that fails for good without a pane or event takes its row with it), an `rd` name when its first event arrives. `session_started` binds
Claude's session id, transcript path and cwd (the join key with `usage`); an older start delivered late does not
overwrite a newer binding. The hook also reports what the pane knows of itself: `FACTORY_ROLE` (the role; a spawn's own
role wins) and its terminal (`HC_TERMINAL_ID` as `pane`, with no tab), so `session get` answers `pane` for an `rd` session too (nothing in the factory reads `tab`).

#### The witness

**The witness** (`witness.ts`, `hc-events.ts`) follows herdr-core's event stream: one long-lived `hc connect` (`events.subscribe`)
keeps a map of every terminal (the snapshot, then `created`/`restarted`/`status`/`turn`/`foreground`/`labels`/`lost`/`finished`/
`removed`; `missed` replaces the map; a line that is not JSON is dropped and the map read again). The stream ending (a core
restart, a dead `hc`, 45 s without a heartbeat) reconnects with a wait that doubles to 30 s and reads `server.status`: a changed
`pid@core id` asks for a pass. While the stream is down `agents()` asks `terminal.list` directly, and a core that does not
answer records nothing. A pass runs every minute, on a debounced `lost`/`finished`/`removed`/`restarted` event of a known
session's terminal, and on a restart; a `status`/`turn` event stores the agent's status at once (`agent_status`). A pass records each session's agent status, the worktree's last
change (`git log` + `git status` with `GIT_OPTIONAL_LOCKS=0`, only for an agent that is working), and the server
(`pid@core id` from `server.status`): a change is the event `runner_restarted` (pseudo-session `_runner`); a stored identity in the
old format (`pid@start time`) is replaced without one. A session is matched to a terminal by its `factory.key` label, Claude session
id, address, then name (a terminal carrying another session's key is never matched, by any of them, nor by a status event); a `terminal.list` never undoes a newer stream event; a record that does not parse fails the whole snapshot or list (the stream reconnects with its backoff), and a failed refresh after an unreadable line makes `agents()` ask the core directly; a finished terminal, or one the core put a shell into after the program died (no status, Claude not in the
foreground), is no agent. A session whose pane is a terminal of this core (`t7`, `t1n`: `t` and base 36, so letters follow `t19`; a classic pane `w4V:p3J` is none) and that no agent matches in two passes in a row
gets `pane_gone` (= `dead`, key per disappearance); a pass in which the runner restarted or could not be identified counts nobody
as missing, and an agent that returns revives the session. Git runs without the server's secrets, `core.fsmonitor` or hooks (the
agent controls `.git/config`), four probes at a time. `GET /sessions` answers with the newest 200.

#### Panes are clients (SF11)

**Panes are clients (SF11).** `POST /spawns` on the socket takes the HTTP route's body, validation (400), role check (422) and
`FACTORY_REPO_ROOTS` check for `repo` and `space` (422, nothing stored), and is idempotent by key (a second create answers the
stored spawn, 200) **while the key is live**. A `started` spawn whose agent is gone reads as `ended` in every view
(`spawn list|get`, the create's answer; nothing stores it): its session is `dead`, or its pane is no terminal of the
current core (a classic-herdr pane, or none). A create under an ended spawn's key answers **409** `{error, code:
"key_spent", spawn}` and never revives the row; the CLI exits 5 (`conflict`) with `code` and `details.spawn` on the error
line, and `rd` derives the next key (`<key>-r2`, …). `factory status` lists neither `started` nor `ended` spawns. The caller is `parent`, which the CLI takes from `--parent`, else `FACTORY_SESSION`. `factory spawn create`
uses the token when `FACTORY_TOKEN` is set and the socket otherwise; `spawn get`, `session get` and `queue get` the same. The
socket has no caller identity, so a pane can name any `parent`: the accepted boundary of SF11, now with spawning in it (the
repo roots still bound where it can start, and a same-user pane can already start Claude Code through hc).
The contract `rd` reads: `Spawn` (`status` `queued` with a `hold` is held, `starting` claimed, `waiting` for capacity; `pane`, `tab`,
`workspace`, `space`, `repo`), `Session` (`pane`, `tab`, `role`), `QueueView` (`effective`), all in `packages/contract`.

#### Test slots (FL7)

**Test slots (FL7)** (`slots.ts`, table `slots`): `factory slot run [--name <label>] -- <cmd>` asks `PUT /slots/:id` on the socket
until it is granted (once a second), renews the lease every 10 s while the command runs (30 s lease; a holder that stops renewing
loses it at the next call of anyone), and gives it back with `DELETE` on exit or `SIGTERM`/`SIGHUP`/`SIGINT`. `FACTORY_SLOTS` slots
(default 2; a signal sent to the wrapper is passed on to the command, and a renewal answered "wait" says once that the lease lapsed), granted to callers in the order they first asked (a waiter that stops polling for 15 s leaves the line), all behind
one advisory lock. The exit code, stdout and stderr are the command's own (killed by a signal: 128 plus it; can't start: 127).
**Fails open:** no answer from the server, or no slot within `FACTORY_SLOT_WAIT_MS` (client side, default 600000), runs the
command anyway with one stderr line. `make test` (so `make check`) runs `bun test` through this checkout's CLI when `factory`
is installed, and bare otherwise (CI).

#### Quota

**Quota is a stored fact, read from the picker.** `ClaudeAccountSource` (`quota.ts`) runs `claude-account usage --json`
(`FACTORY_CLAUDE_ACCOUNT_BIN`, default `~/.local/bin/claude-account`, the Wave 1 process timeout) and parses it with zod: one
row per account of the registry (`dotfiles/config/claude-accounts.json`), so accounts are never listed here and a fourth
appears when the picker lists it. The tick polls at most once a minute (a failed attempt counts; the error goes into the
tick's `errors`, never crashes it); `factory quota refresh` / `POST /quota/refresh` polls now, `factory quota get` /
`GET /quota` shows the newest row per account. `quota_readings` keeps every row: percent of the 5-hour window and the week
(null = no sample), both resets, `enabled`, `auth_ok`, `exhausted_until`, `read_at`, and `sampled_at` (read time minus the
sample's age). `PUT /quota/accounts/:account` stores a reading by hand (tests, operators); the next poll supersedes it.
A reading not renewed for 10 minutes is stale and admits nothing (a stopped poller, an account that left the registry); the
age of the picker's own sample is not judged, only stored. A window the picker has no number for counts as unused (as the
picker weighs it); both without, or no sample time, is no sample and the account is closed. Rows older than a week are
deleted, the newest of each account kept.

#### Admission

**Admission** (`admission.ts`, one function, used at `POST /spawns` and at every claim; first rule that says no wins):
1. queue state `drain`: hold. 2. role `wave` while another live session (derived state not `dead`) of a `wave` spawn
has the same repo: hold `wave`, except a session that has finished (`idle` after a turn that ended since its last `session_started`, or resumed (`source: resume`) with no
turn since a life that had finished, whoever resumed it: a chain wave leaves its tab open once it spawned its successor, and must not hold it
forever, nor a restart that resumed it) (fan workers and other roles are never limited; sessions `rd` starts count by the role their pane reports (`FACTORY_ROLE`, recorded at `session_started`) and by the
directory they started in; a session belongs to the repo when it started there or below it, or when the repo is a `.claude/worktrees/…` worktree of the directory it started in (a session in a parent folder is in no repo); a `failed` spawn whose agent still runs, and a spawn waiting to retry its start, are live sessions: the tab is kept and the
agent may run). 3. `pace` and any live session of the project: hold `pace`. (A role `reviewer` is admitted by its own rules, below, right after `drain`.) 4. an account: enabled,
auth fine, a sample, not `exhausted_until`, below 85 % of its 5-hour window and below 95 % of its week; under `pace` also
weekly use at or below the elapsed share of its week. Never spills: with no account open the spawn is `waiting` with
`resume_at` the first time any account opens by its own reading (a window's reset; both windows closed: the later one; under
pace the moment the elapsed share reaches the use); none if no reading names a time, or if an account is open by its standing
and only its load keeps it from being picked (a far reset of another account is no opening then), a new reading wakes it.
**The spawn cost is not a number:** an account takes one new spawn per sample. A queued or starting spawn holds its account (no agent runs yet, no sample
can show it); a started one holds it until a sample is taken after the moment it started (`assigned_at`, moved to the start;
`sampled_at` is stamped before the picker is asked). Then the account is offered again (the poll shows it within about a
minute). A burst starts as many spawns as there are open accounts
and the rest wait for the next sample.

**A reviewer (review v4)** skips `wave` and `pace` (it reads the repo of the very session that asked for it, which `pace` would hold it behind) and is admitted by three
rules, after `drain`: **`review_slots`**: at most `FACTORY_REVIEW_SESSIONS` (default 2) live reviewer sessions host-wide (a session is live from the claim until its
attempt has a row in `factory.review_outcomes`, or it is `dead`); **the review ceiling**: an account is eligible only below 70 % of its 5-hour window and below 90 % of
its week (`REVIEW_FIVE_HOUR_LIMIT`, `REVIEW_WEEKLY_LIMIT`, next to the usual 85/95 in `capacity.ts`; a window with no number counts as unused, so an account with no 5-hour
reading is judged on its week, and one with neither is not eligible); no eligible account is a `waiting` spawn with `resume_at` the first opening, like any spawn: a review waits and never spills; **`deep_cap`**: a spawn whose
`review.tier` is `deep` starts only on an account that has started fewer than `FACTORY_REVIEW_DEEP_CAP` (default 15) deep reviewer spawns since 00:00 UTC (counted from the
first claim of `starting` and `started` rows); with every open account at the cap it is held `deep_cap` and the owner is asked (below). The tier is never lowered. The
owner's `allow` sets `spawns.deep_allowed` on that one row and makes it due; admission then skips the cap for it and for nothing else.

#### The review transport

**The review transport** (`src/review/`; migration `029`): review v4's hidden transport. agw prepares a review job (no model in agw) and asks the factory for one
interactive Claude Code session per attempt: `factory spawn create review-<jobId>-a1 --repo <root> --role reviewer --placement hidden --review-job <jobId> --review-tier
light|standard|deep --effort low|medium|high --prompt '<job line>'` (`POST /spawns` takes `review: {jobId, tier, effort}`). Only role `reviewer` takes `review`, and it
requires it; the key must be `review-<jobId>-a1` or `-a2`, so the attempt is a function of the key and a replayed request is the same spawn. The row stores `review_job`,
`review_tier`, `review_effort` (`Spawn.review`); the role table's `reviewer` (`sonnet`, `medium`) is the row's tier and effort, the session's `--effort` is the review's.
The session runs the global `reviewer` agent (read-only: Read, Grep, Glob, Agent; defined in dotfiles) and `--disallowed-tools` names every built-in that writes or runs
(`REVIEWER_DISALLOWED_TOOLS` in `hc-runner.ts`: Bash, PowerShell, Monitor, Write, Edit, NotebookEdit, EnterWorktree, Artifact, Workflow, RemoteTrigger).

**Submit on Stop** (`review/transport.ts`, `ReviewTransport`). The Stop hook already ends the session's turn (`turn_ended`, derived state `idle` with a turn); the tick
kicks the transport after its own work, which runs one pass at a time behind the tick's back, in no transaction, with its ports injected (`Runner.close`, a `ReplyReader`,
a `ReviewSubmitter`, the transcript's modification time). A pass looks at every `started` reviewer spawn with no outcome row. For one whose turn ended (or whose session is `dead`): the
**last assistant message** is read from `sessions.transcript_path` (bound by `session_started`) by `fleet/transcript.ts`'s reader: the last `text` of the last `assistant` line
after the last prompt, the end of a 512 KiB tail, thinking and tool calls skipped; none after a 15 s grace is a failed attempt. It goes **verbatim on stdin** to
`agw review submit <jobId> --attempt <n> --account <the account the spawn started on> --commit --format json` (`FACTORY_AGW_BIN`, `runProcess`, 60 s, stderr captured). Exit 0:
`Runner.close(<key>)`, then the outcome `submitted` (row in `factory.review_outcomes`, primary key the spawn key, written last). Non-zero: the attempt is closed and, for `a1`, a
spawn `review-<jobId>-a2` is made with the same review and the prompt `<original>\n\nYour previous reply was refused by agw review submit: <message, 2,000 characters at
most>. Reply again with only the JSON.`; `a2` refused is `needs_human`. **Superseded is final:** a refusal whose message says the job was *abandoned* (a later `prepare` restarted its round) or is *already submitted by attempt N*
(another attempt won; agw's `ReviewError` texts in `host/review/submit.ts`) closes the terminal and records `superseded`: no `a2`, no person. A timeout or a missing binary is no refusal: the same attempt is asked again after 30 s.
**Walled or silent:** a reviewer whose derived state is `walled` (a usage limit; nothing resumes a reviewer) is a failed attempt at once (outcome `walled`, an `a2` whose prompt says the session hit a usage limit), and one still `starting` (or idle with no turn) `FACTORY_REVIEW_IDLE_MS` after its last event is a failed attempt like an idle one; either way the terminal is closed and the slot given back, and `a2` goes through admission again (a ceiling-held account makes it wait). **Idle watchdog**, in the same pass: a reviewer whose turn is open (`working`, `stuck`, `blocked`) and whose transcript file has not been written for
`FACTORY_REVIEW_IDLE_MS` (default 10 min; the turn's start when the file cannot be read) is closed, outcome `idle`, then `a2` (with a prompt saying so), then `needs_human`.
There is no other time limit on a review. **A reviewer is never resumed**, because a resumed session would lack the read-only argv: `rules.ts` leaves role `reviewer` out of every rule (restart resume, watchdog, rotation, blocked, wake), and a `via: resume` prompt for one is refused. A reviewer whose terminal is lost
(`pane_gone`, so `dead`) or that was open when the runner restarted (a `runner_restarted` after its `session_started`) before its turn ended is a failed attempt like an idle one (`a2` once, a fresh session, then `needs_human`); one that had ended its turn still hands its reply over.

**`factory spawn cancel <key>`** (`POST /spawns/:key/cancel`, token API and socket; `cancelSpawn` in `spawns.ts`): a `queued` (any hold) or `waiting` spawn that was never claimed becomes `cancelled` and no agent ever starts for it; the same call again answers the same row; a `starting`, `started`, `failed` or `ended`
one is 409 `not_cancellable` naming its state and carrying the spawn row (`spawn`; the CLI's error line has it as `details.spawn`, exit 5), so a caller reads `spawn.status`, never the message. A cancelled key is spent (a create under it is 409 `key_spent`), and the spawn is left out of `factory status`. agw's `scripts/verify.sh` cancels a smoke review that is held, so it does not run later on a deleted fixture. Replays are harmless by key: `agw review submit` is idempotent per (job, attempt), `createSpawn` returns the `a2` that exists,
`close` finds its terminal by label.

**Asks.** `needs_human` is an attention line, `review <jobId> needs a human: attempt 2 failed: …` (3 days), so an ask on `/fleet` (tier `yours`). A deep review held by
the cap is the line `review <spawn key> held: deep cap reached on every open account today (UTC), started <account n/cap, …>; allow runs it past the cap`, which the triage
makes a `one_click` ask with the intent **`allow`** (`ActIntent`; `fleet_acts`, closes the occurrence like `resolve`, idempotent: a repeat answers the first). `allow`
sets `deep_allowed` on the named spawn and wakes it; nothing else.

#### Queue state

**Queue state `run|pace|drain`** (`queue.ts`, table `queue_states`): per scope, global (`project` null) or a project (the
repo path, resolved like a spawn's); `initiative` is a nullable column for F4, not read yet. No row is `run`. The most
restrictive scope that applies wins. `drain` starts nothing and never interrupts; `pace` as above. A spawn held by a rule
stays `queued` with `hold` set (`drain|pace|wave|claim|review_slots|deep_cap`) and no account, looked at again every 30 s (`HOLD_RECHECK_MS`), and
`queue set` makes held and waiting spawns due at once. `factory queue get|set [--project <path>]`, `GET|PUT /queue`.

#### Roles

**Roles** (`config/roles.json`, schema in `packages/contract/src/roles.ts`): role → tier (`haiku|sonnet|opus`, never a
model id) and effort (`low|medium|high|xhigh|max`). `deep` is a worker raised for novel hard logic (opus, high): placed like a worker. `reviewer` (sonnet, medium) is review v4's read-only session: placed hidden, admitted by its own rules (above), and it alone takes `review`. `POST /spawns` takes `role` (default `worker`; unknown = 422, but a replay
of a known key answers with its row) and
stores the table's tier and effort on the row; the Runner starts Claude Code with exactly those. The server reads the file
at boot (`FACTORY_ROLES_FILE`; it refuses to start on an unusable one), so an edit needs a deploy or restart, and a
spawn keeps the tier and effort it was queued with. `factory role list|get <role>` reads the file
itself, with no server and no token: `rd --role` depends on `role get <role> --format json` printing exactly
`{"role","tier","effort"}` (exit 0; unknown role is exit 4). Values change only on measured data.

#### Process, health, contract, schema and API

**One process.** A session-level Postgres advisory lock is taken before anything else, and a watchdog exits the server
if its connection loses it; a second copy exits 1. Every
advisory key lives in `src/locks.ts` and they must stay distinct.

**`/health` is the ticker's pulse:** the last successful tick and the last tick error; no success within three
intervals (or a pass past its lease) is 503, which fails `make verify` and the deploy health check.

**One contract.** Response shapes are zod schemas in `packages/contract`; the server builds every body through its
schema and the CLI parses with the same one (a body that does not parse is exit 9).

**One schema, `factory`,** in the shared database; migrations are advisory-locked and qualify every name.
The `factory` role owns the schema in the database `shared` (`vps: make db-shared`), holds no CREATE on the database
and has 10 connections; `launch.sh` builds `DATABASE_URL` from its password (`.env.tpl` refs through `secrets-run`),
never from a tracked file.
Migrations are expand, then contract.

**The API is authenticated.** Every route but `GET /health` needs `Authorization: Bearer <FACTORY_TOKEN>`; a body
needs `application/json` (415), at most 64 KiB (413), and the Host must be loopback (421). The CLI reads the token
from `FACTORY_TOKEN`; run it under `secrets-run run --env-file=.env.tpl -- factory ...`.

## 4. The Issue machine (F2)

An Issue lives for hours or days, so no run does: **each Issue is a state machine in Postgres, driven by an
inbox.** No DBOS and no Effect Cluster or Workflow (SF6). engrams' ADR 0119 states the rule ("the automation is
stateful; no run is"), and DBOS's version gating stranded their runs on deploy.

```mermaid
stateDiagram-v2
  [*] --> settling: incident
  [*] --> queued: request or bug
  settling --> closed: healed or runbook
  settling --> queued
  queued --> working: a lead starts
  queued --> closed: stopped
  working --> waiting: a decision, a wall, a dependency
  waiting --> working
  waiting --> closed: stopped
  working --> watching: shipped with evidence
  working --> closed: closed or dropped with a reason
  watching --> closed: holds, or stopped
  watching --> working: regression
  closed --> queued: same fault within 30 days
```

*Parked* is `waiting` with a reason (`reason`: `wait`, `blocked`, `decision`, `wall`, `dependency`, `parked`, `unreported`: a lead that stopped twice with nothing reported, `lead_gone`: its spawn failed or ended, so the news had nobody to go to). A `wait` needs a time in `until`, which sets `wake_at`. A stopped Issue
is closed as dropped, from any open state: `outcome` is `done`, `dropped` or `healed`. Pausing is a flag on the project.

- **One writer.** `issues.state` changes in one module, `src/issues/lifecycle.ts`: its `TABLE` (event → state → step) is the
  transition table, a test pins its edges to this diagram, and the same transaction writes an `issue_events` row for every event
  it applies. What is not the table lives beside it: `create.ts` (a create, always `queued`), `deps.ts`, `decisions.ts`, `timers.ts`, `shared.ts`.
  The reversal bound measures the table's module (about 290 lines in Wave 4). An event a state has no entry for moves nothing: a session event is `ignored`, anything else `refused` with a
  line in `issue_events`. No entry leads to `settling` and a create is always `queued`, so a request cannot reach it (F3).
- **One inbox.** Everything that concerns an Issue is a row in `issue_inbox` with a unique key. A session event on
  a session with an `issue_id` is copied in by the same transaction that stores it (`recordIn`, the only writer of session
  events, so the live post, the spool replay and the witness all pass there). A `turn_started` takes back only what a wall parked, and only from the session that hit the wall (`wall_session`).

| Event | Sent by | Key |
|-|-|-|
| `signal` | dedup (F3, no sender yet): a repeat (recorded, the state stays) or, with `regression: true` in its payload while `watching`, a regression | the source's event id |
| `admitted` | the admission tick | `admit:<issue>:<attempt>` |
| `phase`, `wait`, `ship`, `close`, `block`, `ask`, `drop` | the lead, via `factory issue` (`POST /issues/:id/:verb`, port or socket; the call id is `--id` or generated; the attempt is in the key, so a second attempt's `--id 1` is its own event, and a verb filed for an earlier attempt that is handled after a new one began is refused) | `<issue>:<attempt>:<verb>:<call id>` |
| `unreported` | the send-back: a second stop of a turn with nothing reported | `unreported:<issue>:<session>:<turn>` |
| `reopen` | `factory issue reopen` (`POST /issues/:id/reopen`, token or socket) | `reopen:<issue>:<call id>` |
| `stop` | `factory issue stop` (`POST /issues/:id/stop`, token only) | `stop:<issue>:<call id>` |
| `lead_gone` | `note_lead` when the lead's spawn failed or ended (the Issue working), `start_lead` when the worktree could not be made, and the tick's sweep of a working Issue whose lead's spawn failed | `lead_gone:<effect key>`, `lead_gone:sweep:<issue>:<revision>` |
| session events | hooks, live or from the spool | as in §3 |
| `hold_over`, `wake`, `answer`, `lapsed` | the tick, when `wake_at` passes (`answer` with the default of a question whose expiry passed; `lapsed` when it had none) | `hold:<issue>:<attempt>:<hold>`, `wake:<issue>:<waits>`, `answer:<issue>:expired:<decision>`, `lapse:<issue>:<decision>`: `hold` counts the ships and `waits` the timed waits, as a second ship or a second wait for the same time is a timer of its own |
| `verified`, `regression` | the check after the hold, green or red, each naming its `hold`: an answer for an earlier hold is refused. A `regression` is also a `signal` with `regression: true` (F3), which names none | `verified:<issue>:<hold>`, `regression:<issue>:<hold>` |
| `note` | the owner, `factory issue note` (`POST /issues/:id/note`, token only) | `<issue>:note:<call id>` |
| `answer` | the owner, `factory issue answer` (`POST /issues/:id/answer`, token only) | `<issue>:answer:<call id>` |
| `prio`, `dep`, `retier`, `park` | the orchestrator (F4): the table has entries, nothing sends them yet | the intent's id |
| `settled`, `healed` | settle (F3, no sender yet) | the run's id |

- **One Issue at a time.** A tick pass takes the Issue with the oldest unhandled row and locks its row with `FOR NO KEY UPDATE
  SKIP LOCKED`, the form that leaves foreign keys alone: copying a session event in needs `KEY SHARE` on the Issue and never waits
  for a worker. It works through up to 50 rows in one transaction, oldest event first and failed rows after the rest, with a savepoint per
  row: a handler that throws undoes that row alone, leaves the error on it and in the tick's errors, and the rows behind it, an
  owner's `stop` among them, still apply. The failed row stays unhandled and is tried again every pass until the Issue moves past it: then it is refused as
  superseded, so a retry never acts on a later attempt.
  Events carry what they end: a wake its `for`, the end of a hold and its proof their `hold`, so one that arrives late refuses.
- **Effects run after the commit.** A step's effects (`start_lead`, `note_lead`, `verify`, `finalize`; every step into `closed`
  has `finalize`) are rows in `issue_effects` under `<effect>:<inbox key>`, in the transition's transaction. `runEffects` calls
  the port outside any transaction, only for each Issue's oldest open effect, so nothing overtakes an effect that failed, least
  tried first. A step into `closed` cancels the Issue's open effects but `finalize` (`cancelled_at`): a closed Issue
  gets no lead, note or check, and `finalize` waits behind nothing. A crash after the
  call calls it again under the same key, so a port must find its own work by that key. The ports are `issues/lead.ts`
  (`start_lead`, `note_lead`), `issues/hold.ts` (`verify`) and `issues/finalize.ts` (`finalize`), wired in `TickDeps.issuePorts`. `verify`
  and `finalize` take minutes, so they run **off the tick** (`issues/offtick.ts`): the port's first ask starts the work and throws
  `Waiting` (no try: `attempts`, which the notifier's failed sweep counts, stays as it was), and the ask after it ended returns or throws what it did. Work that threw starts again after a backoff (30 s doubling to 5 min). At most four run at once, and nothing of it outlives the process:
  a stop kills `make verify`'s process group, and every `process.exit` takes running groups along, so a restart never has two (a `kill -9` of the server is the one exception), a check killed that way files nothing, and a restart asks again and finds what it already did by its keys. `verify` keeps a line of its own in `runEffects`: a note reaches the lead while it runs. `hold_over` asks for `verify` and closes nothing: the
  check's `verified` or `regression` moves the Issue.
- **Dependencies.** `dep` refuses a closed Issue, itself and a cycle, and locks the blocker's row so a close in flight is seen. A
  close removes every `issue_deps` row on and of the Issue: a row is a dep still open, and a blocker that reopens holds nobody back.
  Every way to close (`close`, `drop`, `stop`, `verified`, `healed`) is the one `to: closed` branch of `applyEvent`, which calls
  `releaseDependents`. `factory issue new --after <id>` (repeatable, at most 20; `after` in the `POST /issues` body) writes the rows in the create's
  transaction, through the same blocker check as `dep` (`blockerRefusal`, `deps.ts`): an unknown or closed id is 422 with the reason and nothing is stored (a new
  Issue cannot close a cycle). The ids are in the `created` event's payload (`after`). A repeat of the same `(source, key)` is a read: it returns the stored
  Issue and neither checks nor writes `after`, so a repeat with another `--after` changes nothing. A plan is Issues linked this way (decision RS1).
- **Priority.** `factory issue prio <id> <n>` (token only, `POST /issues/:id/prio {value, id?}`, `value` an integer −1000..1000) files one `prio`
  inbox event keyed `<issue>:prio:<call id>` (a repeated call id is 200 `duplicate`; a closed Issue is 409). The lifecycle records it as an
  `issue_events` row; nothing is stored on the Issue. Admission derives an Issue's priority from its latest such event (by `at`, then `id`; none is 0).
  Applied by the next pass that handles the inbox, so it counts from the pass after that.
- **Intake.** `POST /issues` (token and socket, `factory issue new`; `GET /issues[/:id]`, `issue list|show`) and `createIssue`
  for what the server files itself. An Issue has `source` (`request|alert` through the API, open in the table), `source_key` (unique per
  source, required: the CLI makes one per call unless `--key` says otherwise), `repo` (resolved and checked like a spawn's,
  422), a title with control characters removed, and `facts` (any JSON, at most 32 KiB, data, never instructions; what Postgres
  cannot store is 422). A repeated key answers 200 with the stored row, a closed one too. An `alert` is refused (422, naming no path) when its path as given or resolved has an
  `IuRoot` segment, or resolves inside `$HOME/IuRoot` (configured or not) or a configured root of that name: decision 3, in the
  function the door uses too.
- **Classify.** A queued Issue with no `classified_at` is classified by `agw factory-classify --format json` (`issues/classify.ts`): the
  Issue's title and facts on stdin as JSON, exit 10 resumed with `agw run wait <runId>`, each call under a process timeout and `childEnv()`.
  It runs on its own, off the tick (a classify takes minutes, and the tick's health is judged on it): the pump starts at most two, and a
  result is stored by its own transaction with an `issue_events` line (`classified`, or `classify_failed` with the reason). The answer
  `{ project, kind, class, size, tier, effort }` is zod-parsed. The Issue's repo decides the project, never the answer. Tier and effort
  are cut to the role table's `lead` entry and never above `opus/high`, and a risky or business class or an incident is never below `sonnet/high`; the lead starts at that level worked out again against the table of that moment. A classify that fails, times out, does not parse or whose
  command is missing stores the `lead` entry as the defaults: the Issue is admitted all the same, never stuck. A restart loses what was in
  flight and the next pass asks again. Only an Issue with `classified_at` is admitted.
- **Admission.** Each pass, under the capacity lock, of the classified `queued` Issues **with no `issue_deps` row** (an open dependency), the first
  of each project and any urgent one (an incident, or the owner's `urgent` class: Classify never answers `urgent`) are looked at. First is the highest
  `prio`, then the oldest id, chosen among the unblocked ones: a blocked Issue is no candidate, so it never holds back an unblocked one of its project.
  Urgent ones go before the rest, then by prio and id. Those the project's claim has room for hold the claim and get
  `admitted` (key `admit:<issue>:<attempt>`), which plans `start_lead`. The rest of a project cannot go before its first and are not read.
  Held back, and still `queued`: `drain` for the repo or globally, a paused project, a project not synced yet, a full claim, a reopened Issue whose
  last attempt is not finalized, and an `alert` while `FACTORY_ALERT_LEADS` is off (it is left out of the reading, so it does not stand in front of a
  request); `factory status` says which. Requests are not asked. Decision 3 held alert leads back until evidence and the hold were live: since
  Wave 4 the switch defaults on (`config.ts`), and `FACTORY_ALERT_LEADS=0` turns it off.
- **Attach or start.** `start_lead` asks for the worktree `factory/<issue>-<attempt>` of the repo, made the way `rd fan` does (`issues/worktree.ts`:
  fetch origin, branch from the default branch, `wtp` where `origin/<default>` has a `.wtp.yml`; each step under a timeout; the same branch answers its
  worktree again, with the sha it was cut from, if a marker in its git directory says the setup finished; one without it is removed and made again unless the branch has commits, and a failed setup removes what it made) and **made off the tick** by `WorktreeMaker` (`issues/leadtree.ts`), because `git fetch` can take 90 s and `wtp` five
  minutes: the row in `lead_worktrees` is written first (`pending`), at most two are made at once and one at a time per Issue, a failed try
  backs off (30 s doubling to 5 min) until the retry budget, counted from the first try, is spent (`failed`). The effect waits (`Waiting`, no error) until the
  worktree is `made`, and a `failed` one parks the Issue as `lead_gone` with the reason. Then it looks at the Issue again: a close ends the start, and a `drop` or `stop` not handled yet is waited for. Then it creates the spawn: role `lead`, tier and effort from Classify,
  key and pane `lead-<issue>-<attempt>`, cwd the worktree, space the main checkout, the brief as its argument. A spawn that exists is the attach. The
  spawn's `issue_id` goes on its session, and on the lead's session only: a wall parks the Issue from any session with an `issue_id`, so a
  worker's wall would strand the lead. The brief is recorded as a prompt (`issue:<id>:brief:<attempt>`, `delivered`) in the spawn's own transaction, so a create that fails leaves none, and never typed a second time. A GitHub comment carries a marker, a card a key. A worktree that cannot be made shows in `factory status` with its try and its error.
- **The lead's verbs.** `factory issue phase|wait|ship|close|block|ask|drop <id>` is one inbox row each, key `<issue>:<attempt>:<verb>:<call id>`, on the
  token API and on the socket (a lead has no token). `FACTORY_SESSION` says which lead: a session may only report on the Issue it works, and only its current lead is heard (409; an earlier attempt's lead, still open, is not). A pane that names another session's id stays inside the trust boundary SF11 accepts: the socket's mode 0600 is the credential, as for `session note` and `wait`. On the socket, which has no token, a verb must name one. The `lead-<issue>-<attempt>` spawn keys are reserved (`POST /spawns` refuses them), and `start_lead` attaches only to a spawn of its own Issue.
  The row is handled by the next tick; `ship` and `close`, which the evidence decides, before the call returns.
  `ask` records a `decisions` row, shows in `factory status`, and sets `wake_at` to its `expiresAt`: a passed expiry answers the lead with the
  default (an `answer` from `default`, and a note to the lead), or, with none (or on a `business` Issue, whose questions are the owner's whatever default the lead named), records `lapsed` and keeps the question open with a line for the owner:
  an answer is still taken. An expiry's answer names its question and applies to that one only.
- **The send-back.** On top of §3's workers rule, a stop of a session with an `issue_id` whose Issue is `working`, in a turn the factory
  started (the brief, or a prompt the prompt loop typed: not one the owner typed), with no `ship|close|block|ask|wait|drop` from that session
  since the turn began but a refused one, is sent back with one line (`issue-sendback:<session>:<turn>`). The next stop of that turn, which arrives with
  `stop_hook_active` (the hook asks on every stop and forwards the flag), files `unreported:<issue>:<session>:<turn>`: the Issue is `waiting` for `unreported`, with a line in `factory status`. The same stop
  asked again records nothing.
- **Claims.** `repo:<name>` admits as many leads as the manifest's `leads` allows (one by default) plus one urgent.
- **The evidence gate.** `ship` names its merged commits (`--commit`, required) and `close` may. Before the row is filed, outside any
  transaction, `derive` (`issues/evidence.ts`) has `GitCommits` (`issues/commits.ts`) resolve them: each must exist and be on `origin/<default>`
  (looked for again after a `git fetch`, 30 s: a PR merged on GitHub is on no local ref until then) and newer than the worktree's cut, `ship` needs all the branch holds on the base (`branchOnBase`: by commit; by content, a merge of it changing nothing; or as the reported commits, at one of which every file the branch changes must be exactly as the branch has it, since a squash whose lines later commits moved conflicts in a three-way merge and says nothing by that; what git cannot answer is no proof), and what else the branch
  `factory/<issue>-<attempt>` holds since the worktree's cut counts too, so the commits a lead names do not set its bar (a rebase over
  newer work counts those commits: stricter, never lighter; a merge commit counts as what it brought in). The paths give the kinds required
  by `requiredEvidence`: the manifest's `deploy.migrations` are `data`; `docs/`, `*.md` and tests need nothing; `deploy/`, `scripts/`,
  `config/`, `Makefile`, `Dockerfile` and the like are `infra`; `*.tsx`, `*.css` and the like are `ui`; the rest is `service`. The manifest has no
  keys for these, so they are conventions in one list. `deploy.mode: none`, which is also no manifest, requires nothing. The answer travels on the
  row as `derived` (the body's schema has no such field, so a lead cannot set it); the lifecycle's `gateShip` and `gateClose` decide on it inside
  the transition's transaction, reading `evidence`, and a row without it is refused. A git that fails refuses the verb. The factory
  checks existence and freshness only: a kind is met by a row at or after the newest reported commit's committer time, in whole seconds.
  Refused, the row is `refused` with what is missing in `detail`, the call answers 409 with the same text, and the CLI exits 5. `ship` and `close` are
  handled before the call returns (`answerNow`: the same worker under the same lock as the tick; a row the tick has in hand comes back `result: null`, and
  the CLI exits 10). A repeated `--id` gets the row's answer again without asking git, unless that answer was a refusal: a refusal says how things stood then, so the call derives again as a row of its own (`<key>:retry:<n>`). A refused verb is no report, so the send-back still applies.
  `close` is refused when the commits touch anything that requires evidence, and when it names neither a merged commit nor a `--document`: what is merely on the branch is no proof.
  `factory issue evidence <id> --kind ui|service|infra|data|review` (`--link`, `--file`, `--stdin`; at most 32 KiB) is a row in `evidence` keyed
  `evidence:<issue>:<attempt>:<call id>`, by the lead or the owner, under the same rules as a verb, and takes nothing for a closed Issue.
  **Review is evidence too.** For `ship`, outside any transaction, `derive` also asks `agw review route --base <cut> --head <landedAt>` and `agw review covered --range <cut>..<landedAt>` (host reads, no model, `Review` port, `AgwReview` adapter, 60 s, `childEnv()`) and stores `{tier, covered, uncovered: [{sha, subject, required, reason?}], base, head}` in `derived.review`. The base is the lead worktree's cut sha (`lead_worktrees.sha`), the head is `landedAt`, so commits others landed in between must be reviewed as well. Review is required when the tier is not `none` and met only when agw says `covered`; a filed `factory issue evidence --kind review --link <jobId>` is recorded but does not satisfy the gate. The refusal names each uncovered commit with its required tier. A missing cut or landed commit, or any agw error, timeout or unparseable answer, is `derived.reviewProblem` and refuses the ship (fail closed). The factory never judges coverage or routes: agw owns both. `close` and the hold's version check are unchanged (`review` is not in `derived.required`).
- **The hold.** `ship` moves it to `watching` with `wake_at` at now plus the manifest's `hold`. A passed `wake_at` is `hold_over`, which plans `verify`:
  no check for two minutes after the server starts (`make deploy` writes what `make verify` compares only once `/health` answers, so a hold ending in a deploy would read as a regression), then off the tick. Under `deploy.mode: make`, when the ship that started this hold changed something that deploys (its `derived.required` is not empty; the ship row is the newest applied one of this attempt), the first check is `make version` in the repo (`deployed version`, 30 s, read-only, always run: only make knows whether the target exists). It must print one line, the deployed commit sha, and that commit must be `derived.landedAt` or hold it as an ancestor (`deployedHolds`, `issues/origin.ts`; a deployed commit the repo has not seen is fetched for, which writes remote refs and objects only). `landedAt` is `origin/<default>` as `derive` found it when the ship proved the work landed (`CommitRead.landedAt`): one sha that holds everything on the branch and every commit named, so a lead that names only an early commit, a squash, a rebase and the 100-entry cut of `commits` change nothing. `merge-base --is-ancestor` exit 1 is "not deployed"; any other exit is `could not compare: <reason>`. The check is closed on every gap: no ship of this attempt on record, no `derived`, no `landedAt`, or no project row at hold time (checked first, whatever the ship row holds) is a red check with that reason. Only a ship whose commits require no evidence skips it, as do the modes `auto`, `agentic` and `none`. A missing target is make's own top-level `make: *** No rule to make target 'version'` line (read under `LC_ALL=C`; not a sub-make's, and not one followed by a failed recipe's `[version] Error`) and reds with a line saying `make version` is a probe: the owner adds it, a lead does not, and the lead answers with `factory issue block`. Any other failure shows `stdout: … / stderr: …` (the end of each, 1,500 characters) in the detail; the shell catches stderr through the pipe, so a kill leaves no file behind. **The factory never writes a checkout:** it does not pull, fast-forward or clean one, and deploying from the main checkout is the lead's job (§5). The probes and `make verify` run whether the version check is red or not, so the lead sees every signal. Then `make verify` in the repo where the make contract has it (10 min, `childEnv()`, stdout and stderr kept, the last 1,500 characters) and
  an HTTP GET per probe (15 s, redirects are answers), pass or fail, never averaged. No check at all is green. Green files `verified`: closed, the
  results in `evidence` (kind `hold`, author `factory`). Red files `regression` naming the hold: back to `working`, one note to the same lead under
  `issue:<id>:regression:<hold>` with the results as JSON on one line, data, and `notify:regression:<issue>:<hold>` on the owner's line. A check whose hold ended meanwhile files nothing, and one whose answer is filed
  runs nothing.
- **Finalize once,** from every exit path (`issues/finalize.ts`), in this order: on the tick, so no check can hold a project's place, the claim is given back, a lead's spawn that never started fails, and
  whoever waited for the place is looked at now, unless a later attempt holds the claim by now (a finalize planned before its port existed); off it, the terminals of the lead and the workers it spawned are killed and removed (`Runner.close`, by their label); the attempt's transcripts, the
  lead's and those workers', if they really lie under the account's Claude projects directory (the path is the pane's word; otherwise a `transcript_missing` line), are copied to `FACTORY_ARCHIVE_DIR` (default `~/.local/share/factory/archive`)`/<issue>/<attempt>/<claude session>.jsonl`, with the
  subagents' directory beside it, and linked in `evidence` (kind `transcript`), never parsed; the worktree and its branch are removed when clean and on the fetched
  base (`branchOnBase`, with the commits the lead reported: a squash leaves no commit of the branch behind), otherwise kept with an `issue_events` line
  and a week in `factory status` (ignored files are the setup's, and go with it). `issue_finalized:<issue>:<attempt>` ends it: a second close of an attempt that has it only gives the place
  back. A finalize that fails is tried again and shows in status, and the place is back already. Every step finds its own work done, so a crash between any two replays to one of each.
- **Reopen.** `factory issue reopen <id> --reason <text>`, the only way a closed Issue moves: within 30 days of closing it is `queued`, and admission gives it a
  new attempt and a fresh worktree once the last attempt's `finalize` is done, so the old lead is gone before a new one starts. Past 30 days it is
  refused with a pointer to `factory issue new`.
- **Stop.** `factory issue stop <id> --reason <text>` is the owner's way to end an Issue in any open state, one with no lead too, which no lead verb can reach: closed as `dropped` with the reason in `issue_events`, answered before the call returns like `ship` (202 and exit 10 when the tick has the Issue in hand: the same `--id` asks again), and finalized like every close (with no attempt, only its place goes back). Token only: the socket has no such route, so no pane can end an Issue. A closed Issue is refused.
- **Resume.** `factory issue resume <id> [--attempt <n>]` (`issues/resume.ts`) spawns `claude --resume <session> --fork-session` through the queue and the Runner:
  a tab in the repo's main checkout, role `lead`, no `issue_id`, so it takes no claim and reports on nothing. The Runner puts the archived file back under
  the account it got, in Claude Code's project directory for that path, an assumption about Claude Code's layout and the only one.
- **Following an Issue** (`issues/follow.ts`, reads only). `factory status` and `GET /status` carry an ISSUES section: every open Issue
  (and a closed one, for 24 hours, whose finalize failed) with its state, repo, the lead's session (the current attempt's, once it exists), the
  lead's last `phase` of this attempt, when the factory looks again (`wakeAt`: a timed wait, an expiry, the end of a hold), what it waits for (`waiting`: the reason; a `queued` Issue the project's claim has no room for:
  `claim`), the evidence still missing, and the open questions. Most urgent first (a failed finalize, `waiting`, `working`, `watching`,
  `queued`), at most 40, the rest counted (`issuesMore`). `claim` is shown for the Issue admission looked at (a claim row exists, not held: the first of its project, highest prio then oldest, among the unblocked); Issues queued behind it have no claim row and show nothing. Read from stored rows only, never git: the evidence missing is what the last `ship`
  or `close` of this attempt derived from its commits (`derived.required`, on its inbox row), less the rows in `evidence` that are
  fresh by the gate's own rule (`unmetKinds`), so until a lead has tried one, nothing is known and nothing is listed.
  Those that need a look (an open question, a park, a lead or worktree that did not start, a finalize that failed) also have a line in ATTENTION (§3 "`factory status`"). `factory issue show <id>` (`GET /issues/:id/timeline`, token or socket) is the
  Issue with its facts, its story oldest first, its evidence and its questions: the story is the Issue's `issue_events` (what the lifecycle
  applied or refused, with the state it moved from and to) and the inbox rows no event came of (still unhandled, with the error of a row
  that failed; a session's silent events are `factory session get`'s), the newest 500 with the rest counted (`timelineCut`), and the newest 200 pieces of evidence with the rest counted (`evidenceCut`). Every payload
  is data as its sender filed it: on a terminal, one cut line, `key=value`, control characters gone. `--format json` is the whole.
- **Notes.** `factory issue note <id> <text> [--id <call id>]` is the owner's way to reach a lead (`POST /issues/:id/note`, token only: a pane
  can already type into a session with `session note`, and what a brief carries is the owner's). One inbox row `<issue>:note:<call id>`;
  an Issue that is `queued`, `working`, `waiting` or `watching` takes it, a closed one is 409. The lifecycle records it, and for an Issue with
  a lead plans `note_lead`, which types it through the session notes of §3 (`recordPrompt`, source `note`, prompt id `issue:<issue>:note:<call id>`,
  so a repeated id types once; a pane's `session note` cannot take an `issue:` id) and tries again until the lead's session exists. A note filed as the Issue closes is refused by the lifecycle with a line in the timeline. An Issue with no lead running keeps it as the row, and the
  **next brief carries it** (§5 "The brief"). A lead that is gone, whose Issue is not `working`, is not parked for it: the note stays in the
  timeline. An Issue that is not `working` and whose lead never got a spawn (the worktree failed: `lead_gone`) ends the effect quietly, so it holds back no later
  note, wake or answer, and the note comes again in the next brief.
- **Ids and a restore.** Not built for Issues. `issues.id` is a sequence, and nothing moves it past the ids in pane names (`lead-<issue>-<attempt>`) or the
  spool after a restore, nor rebuilds an Issue the dump lost from the spool: the F1 gameday proved it for sessions and spawns, whose keys are not
  sequences. The F2 gamedays of §13 (Wave 6) decide it.
- **Schedules.** Not built (F3): a Postgres lease, and `job_runs` unique per (job, slot).
- **Tests.** A golden test pins each path's sequence of transitions and effects. A replay test crashes after every
  effect and replays, and must end with zero duplicates.

Reversal condition: the lifecycle module passes about 500 lines, or the replay test finds a race the per-Issue lock
cannot close.

## 5. The loop

| Step | Owner | Engine | Out |
|-|-|-|-|
| Intake | factory | a poller per source (F3); requests skip to Classify | Signal |
| Dedup by symptom | factory | rules; the judge once trusted (§8, F3) | a new Issue, or a Signal attached |
| Settle + runbook | factory | a grace timer; a runbook from `project.yaml` (F3) | healed and closed, or queued |
| Classify | factory | one `agw` workflow | project, kind, class, size; the lead's tier and effort |
| Queue + admit | factory | §3, §7 | an account, or a `resume_at` |
| Spawn | factory | `Runner`, in a worktree of the lead's own | a lead with the brief |
| Root cause → production | **lead** | Claude Code on Max, alone or with workers | shipped with evidence, closed, blocked or asking |
| Watch | factory | the hold, `make verify`, the probes | closed, or a regression back to the lead |
| Learn | factory | `agw` workflows, from the lead's report (F3) | known fix, labels, runbook candidates, changelog |

**Three ways in.** Signals from sources and jobs go through dedup (until F3, an alert reaches the loop through the door, §11, as one Issue). Requests go straight to Classify. Built:
`factory issue new` and `POST /issues` (so a pane, Argo or Hermes can file one). Designed, not built (F3): a TickTick item tagged `#factory`, a GitHub issue labelled `factory`, a `/factory` comment by
the owner. A label starts work rather than authorship, because every agent on the mini acts as the owner's GitHub
user; an issue labelled `alert` is a signal. The factory never triggers on its own comments, and text it cannot parse
triggers nothing. Initiatives are requests too big for one lead; the orchestrator plans them into child Issues.

Every repo under `~/SourceRoot` takes requests, with or without a manifest.

### The lead's job

| Phase | The lead | With |
|-|-|-|
| Investigate | reproduces, reads logs and traces, finds the cause; merges or splits Issues when the cause says so (F3: `merge` and `split` do not exist yet) | `/otel`, `make logs`, `factory issue show` |
| Plan | picks the shape: alone, subagents, `rd fan` or a `/wave` chain | `/research`, the project's docs |
| Build | implements and writes the tests | `@implementer`, `rd fan` |
| Check | `make check`, `make test`, a review | `/check`, `/review` |
| Verify locally | sees it work | `@verifier` |
| Ship | merges by the manifest's `ship` rules, deploys by its `deploy.mode` | `make deploy`, `/ship` |
| Check production | the same evidence against the running system | `make verify`, `/otel`, screenshots |
| Report | `factory issue evidence`, then `factory issue ship` with a three-line summary and the merged commits | `factory` |

Production says no: the lead fixes forward, while it still holds the context. A revert is its call, never a factory
reflex.

### Done means evidence

The factory derives the evidence an Issue needs from what its merged commits touched, so a lead cannot pick a
lighter bar: `ship` is refused without it, and `close` is refused when the commits touch deployable paths. The
factory checks that the evidence exists and is fresh. Judging it stays with the lead and the review. How the paths become
kinds and how the check runs: §4, "The evidence gate".

| Change | Evidence |
|-|-|
| UI | a production screenshot of the changed screen, at phone width if the page is used there |
| API or service | `make verify`; error rate and p95 of the changed endpoints, before and after |
| Infra or config | the service's status and logs after the change |
| Data or migration | the queries that show the data is right |
| Deploy mode `make`, any change that deploys | the deployed version: the hold reads `make version` and is red unless it holds the shipped commits (§4, "The hold") |
| Nothing deployed | the commit or the document, via `factory issue close` |

Under mode `make` the brief orders the deploy in the project section (identical in every brief of that mode but for the path): in the repo's
**main checkout**, check it is on the default branch and clean, `git pull --ff-only`, `make deploy`, `make verify`, `make version`, then `ship`;
never from the lead's worktree, because a repo whose `make setup` links its own `pwd` would point the install at a directory that goes away. The
deployed version is read, not claimed: no evidence item stands for it, and the factory does not move the checkout to make the code present.

**No lead edits a probe within the Issue it ships**, and `make version` is one: no target means `factory issue block`, the owner adds it. Each deployable project lists a few user-journey probes, pass
or fail, never averaged. The factory runs them after every hold. Tests a model wrote for its own change can give
false confidence; the probes are the check that does not depend on it.

### The brief

- **The ask:** the owner's words, or what the signals saw: what, where, since when, how often. Filed as data and fenced for every source (`source` is the caller's choice, and any pane on the socket can file), under "the ask, as filed".
- **Facts:** what the Issue was filed with (`facts`: for an alert, what the door parsed). Alert and
  issue text is marked as data, never instructions: the facts are a fenced block (the fence longer than any run of backticks inside), cut at
  16,000 characters with the way to the rest.
- **Notes from the owner:** `factory issue note` texts filed while no lead was running, oldest first, in a fence, only when there are any.
  Those that reached no session (no prompt `issue:<issue>:note:<call id>` of a session that exists and is `sent` or `delivered`), so a lead that never started,
  and the notes a brief had no room for, come again in the next one. Each is recorded as a `delivered` prompt of the new lead in the spawn's
  transaction (a prompt still pending for an earlier lead, or one of a session that never existed, moves to it; one being typed right now stays, and the brief carries the text all the same), so a `note_lead` for the same call never types it a second time. At most 20 are shown and within 24 KB, with a count of the rest.
- **History:** closed Issues that looked similar, with the verified cause and fix, marked *past, may not apply* and fenced as data. Empty until F3.
- **The project:** make contract, deploy mode, how each path ships, production targets. What comes from the repo's `project.yaml` (targets, migrations, probes, ship rules) is fenced as data too.
- **Done means:** the evidence table and the `factory` verbs.
- **Standing orders:** decide alone except the business classes; ask through `factory issue ask`; workers stay on
  Max; never end a turn on a background shell; every stop reports. Identical in every brief (a constant in `issues/brief.ts`, its hash pinned
  by a test), so they are a prompt-cache hit. For that the brief opens with the standing orders and the done-means text, which are the same
  in every brief, and then comes what is this Issue's: the ask, the facts, the owner's notes, the history, the project.

Classification sets labels and routing, never a cause. The brief shows just kind and class.

### Following a lead

- **A send-back keeps the lead honest.** On top of §3's rule, the `Stop` hook sends a lead back with one line
  (report `ship`, `close`, `block`, `ask`, `wait` or `drop`) when nothing was reported since the turn the factory started, a refused
  report counting as none (§4 "The send-back"). A turn answering the owner is never sent back. A second unreported
  stop parks the Issue (`unreported`) with a line in `factory status` and one on the owner's line (§11), never a card, and from F4 also wakes the orchestrator.
- **New facts go to the running lead** (F3, not built: dedup has no sender). A *possibly related* signal will reach it as a note, not a second session.
  The lead records whether it shares the cause; that answer is the judge's label.
- **The owner can step in at any time** by typing in the tab (the lead treats it like a note and is not sent back for it), or
  with `factory issue note <id> <text>` (§4 "Notes"), which reaches the lead's pane through the session notes and, with no lead running, the next brief.
  Where the Issues stand is `factory status` (ISSUES), and one Issue's story is `factory issue show <id>` (§4 "Following an Issue").
- **After ship** the lead stays open through the 30-minute hold, so a regression reaches a warm context. Once the
  hold, `make verify` and the probes are green, the factory closes the tab and removes the worktree.
- **Where a lead works.** A worktree per attempt on `factory/<issue>-<attempt>`, made the way `rd fan` does. It
  merges by rebase and push, or through a PR it reviews and merges itself where `ship` says `pr`.
- **The session id is the durable handle, not the pane.** At close the factory copies the attempt's transcripts
  into an archive (Claude Code deletes its own after 30 days). `factory issue resume` opens one with
  `--fork-session`. The transcript format is internal to Claude Code, so the factory stores, links and searches
  transcripts and never parses them for decisions.

## 6. The orchestrator (F4)

Under the factory's code run two kinds of agent, one level deep. The factory itself is the conveyor.

| Layer | Does | Lives |
|-|-|-|
| **Orchestrator** | what code cannot decide: plans an initiative into waves and reviews each; steers a stuck lead; sets priority or dependency in a conflict; looks over queue and accounts | one fresh session per event; reads `factory status`, never raw logs |
| **Lead** | one Issue, root cause to production evidence | spawn → end of the hold |

**Wakes:**

- an initiative to plan, or one of its waves shipped
- a stalled lead: two hours of work time with no commit, phase change or declared wait
- a second unreported stop
- a pane dying three times in ten minutes
- three failed production checks, or an Issue reopened twice
- a decision about to take its default
- 06:30 daily, for exceptions only

**It acts through `factory` only:** `issue prio|dep|note|retier|park`, split and merge, `project pause`, a card for
the business classes, an upkeep Issue for a policy change. It never writes code, touches a repo or starts work the
queue does not hold. Until F4 runs, the program lead does this job.

Queue order, first rule first: stop the line, urgent, dependencies, the orchestrator's priority within a class, age.

## 7. Capacity at Issue level (F4)

Extends §3. The scarce unit is the Max window.

| Class | Examples | Gets an account when |
|-|-|-|
| urgent | an owner app is down, data at risk | any account is eligible |
| normal | bugs, requests, initiative waves | an account is under its weekly pace |
| upkeep | upgrades, docs, code health, security | capacity would otherwise lapse at the next reset; every manifest repo still gets one a week |

- **5-hour headroom.** A lead starts on an account only if headroom covers a share per tier, set from measured
  session cost; leads admitted but not yet measured count against it.
- **Stop the line.** While a project's production is red, it gets only fixes.
- **Tier and effort.** xs and mechanical: Haiku, low. s–m: Sonnet, medium. l–xl, novel design, security: Opus,
  medium. A second attempt goes one tier up with its predecessor's notes. Values come from the role table.
- **Balance.** Every account's week ends close to full and work rarely changes account. Switching happens at spawn.
  One exception: a walled lead that would wait more than an hour resumes elsewhere if headroom exists, counted as a
  switch. The prompt cache is gone after such a wait anyway, and the accounts share one transcript store.

| Measure | Target |
|-|-|
| capacity unused at each weekly reset, per account | < 10 % |
| account changes of a running lead | walls only |
| minutes the owner's sessions waited on a wall | 0 |
| leads hitting a 5-hour wall mid-work | falling |
| Issues shipped per 1 % of weekly capacity | rising |

## 8. Dedup and learning (F3)

One cause should be one Issue, and a cause seen before should arrive with its verified fix. Deterministic grouping
scores F1 0.889 against 0.744 for the old system on a held-out set; v1's known-fix match scored 0.479, so "seen
before" stays unproven. Grouping is gated deterministically, with similarity beside the gate, not in it.

| Tier | Who | Asks |
|-|-|-|
| Symptom, at intake | rules; the judge once trusted | is this the same thing happening again? Never waits |
| Cause, during investigation | the lead | do these Issues share a cause? `factory issue merge\|split` with a reason |

- **Rules.** Stateful sources (Kuma, Beszel, containers): one episode per subject until healthy again. Stateless
  sources (CI, logs, `alert` issues): the same refined fingerprint within a window. Topology joins a container's
  failure to its host's.
- **The judge,** an `agw` workflow with an eval set, returns a probability on ambiguous pairs. At ≥ 0.8 it attaches
  them, at ≤ 0.2 it keeps them apart, and anything between is linked as *possibly related*. A failed call keeps
  them apart.
- **Off → shadow → trusted.** It logs verdicts and acts on none until merge precision is ≥ 0.95 over at least 30
  labelled pairs, with grouping F1 still ≥ 0.889. Below 0.95 over the last 30 pairs it returns to shadow. A wrong
  merge hides work and a missed merge costs one note, so precision is the gate.
- **Seen before.** Postgres full-text search over title, root cause and fix, ranked by project, subject and recency.
  No embeddings until full-text misses known fixes someone can name.

Learning keeps four things: labels (lead merges and splits are ground truth), known fixes, runbooks (a fix verified
twice becomes an upkeep Issue that adds it to `heal:`), thresholds (changed only by replaying labels and the frozen
golden set). Four monthly measures show whether it learns: missed-at-intake rate, wrong-join rate, seen-before hit
rate, runbook share. None improving over two months opens an Issue.

## 9. Projects

```yaml
apiVersion: factory/v2
name: weatherorb
deploy:
  mode: auto                 # auto: a push deploys · make · agentic · none
  targets: [{ name: prod, host: vps, verify: https://example.com/health }]
  hold: 30m
  migrations: [apps/api/drizzle/]
  probes:
    - { name: forecast-loads, http: https://example.com/api/forecast?q=berlin, expect: 200 }
ship:                        # first match wins; push or pr
  - { paths: ["**"], via: push }
signals:
  kuma: [weatherorb-web, weatherorb-api]
  hyperdx: { service: weatherorb-api }
heal:
  - { when: kuma.down, grace: 5m, runbook: make restart, max: 2 }
jobs: [deps, docs, code-health]
leads: 1
ticktick: { list: WeatherOrb }
```

- **v0 (F2):** name, `deploy`, `ship`, `leads`, hold, probes. **Later (F3):** signals, heal, jobs, ticktick: accepted and dropped, so an F3 manifest does not break F2.
- **A broken manifest** becomes an upkeep Issue; the factory keeps running on the last valid version.
- **Make contract:** `check`, `test`, `deploy`, `verify`, `version`, `restart`, `quality`, `logs`, `status`. `version` prints the deployed commit sha, one line, and only reads. `check`, `test` and
  `quality` take `BASE=<ref>`. Every target ends in a one-line verdict. A repo is onboarded when it first has signals
  or Issues, with the targets that path needs. The factory itself runs only `restart`, `verify` and `version`.
- **No manifest:** requests only, one lead, done means the commit or document.
- **Project key:** the repo's directory name under `~/SourceRoot`. `factory.projects` and the `usage` schema's
  normalised repos use the same slug (U4). No cross-schema foreign key until both exist.
- **TickTick** stays the list of things only the owner can do; `factory issue block --human` adds an item there.
- **The brain** keeps one page per project; the factory writes only its *Changelog* section.
- **homelab-private** stays self-contained: its manifest lives inside it, and nothing about it appears elsewhere.

### As built (F2 Wave 2)

`packages/contract/src/projects.ts` is the schema, `packages/server/src/projects/` the code (`manifest.ts`, `sync.ts`, `make.ts`,
`claims.ts`, `store.ts`, `pass.ts`), migration `015_projects.sql`.

- **The schema.** `apiVersion: factory/v2`, `name`, `deploy {mode auto|make|agentic|none, targets[{name, host, verify}], hold,
  migrations[], probes[{name, http, expect}]}`, `ship[{paths[], via push|pr}]`, `leads`. `verify` is an `http(s)` URL or `make <target>`; `hold` is
  `30s`, `30m`, `2h` or `1d`, at most `7d`, default `30m`; `expect` defaults to 200; `leads` is 1 to 8. Objects are strict: a key
  that is not in the schema is an error (a typo is not read as a default), except `signals`, `heal`, `jobs` and `ticktick`, which
  are accepted and dropped. Parsed with `yaml` (pinned): YAML 1.2 core, one document, duplicate keys refused, no merge keys, at
  most 100 aliases, at most 64 KiB. `name` must be the directory's name. **No manifest** is `defaultManifest`: one lead,
  `deploy.mode none`, `ship: [{ paths: ["**"], via: push }]` (the factory does not read `pr-required-repos`; a repo that needs a PR
  says so in a manifest), done means the commit or the document.
- **Sync** (`ProjectSync`). The manifest is read from the repo's **default branch on the remote**, as last fetched, not from the working tree: a
  feature branch checked out, an edit not committed, or a checkout that is behind is not what the factory runs on. The branch is resolved first and only it is
  read: `origin/HEAD`'s (`origin/<it>`, else the local branch), else the first of `main` and `master` that exists, on the remote before the local one. The tick fetches behind its back with each full pass and reads the result on the next; `factory project sync` waits for the fetch. A file that is
  not a regular one, or is larger than 64 KiB, is a broken manifest (its size is read from the tree before the blob). A
  full pass visits every git repo directly under a `FACTORY_REPO_ROOTS` root that has a manifest, every repo that has a row and every
  repo an Issue or spawn names (a worktree path counts as its repo: the first directory below the root), at most every ten minutes and
  on `factory project sync` / `POST /projects/sync`. Every other tick looks only for a named repo that has no row. A repo with no
  manifest and nothing naming it is no project. All reading happens before any transaction; rows are written one after the other. Any
  `git` failure or timeout, and a repo with no default branch to find, leaves the row as it was (an error in the tick, not a
  deleted manifest); only a branch that has no `project.yaml` puts the project back on the defaults.
- **Keys.** The key is the directory's name. Two directories of one name (under different roots): the one stored first keeps
  `<name>`, the other is `<name>~<first 8 hex of the sha-256 of its real path>`, and a stored repo keeps its key whatever is
  added later. A claim and a project lookup go by the repo's path (the row whose `repo` is the path or contains it).
- **A broken manifest** (YAML, schema, a `name` that is not the directory): the row keeps `manifest` and `manifest_sha`, records
  `manifest_error` and the content's hash, and `createIssue` opens one upkeep Issue (`source: "upkeep"`, `source_key`
  `manifest:<project>:<sha-256 of the content>`). The same content again finds that Issue, whatever became of it; changed content
  that is still broken opens another. A manifest that parses clears the error.
- **The make contract** is a static read of `Makefile` (`GNUmakefile`, `makefile`) and the files it includes by a literal path or a
  glob (three levels, 64 files, 256 looked at, inside the repo; opened without following a link, 512 KiB at most): the rule targets of `check test deploy verify restart quality logs status`, stored
  as `make_targets` with `makefile`. Not `make -pn`: a Makefile may run `$(shell …)` while it is parsed, and this runs inside the
  server. A target-specific variable (`verify: FLAG=1`) or a pattern rule is not a target.
- **Claims.** `claims` has a row per (key `repo:<project>`, Issue): `held_at` set once it holds, NULL while it queues. A spawn with an
  `issue_id` (`createSpawn`'s `issueId`; the HTTP `POST /spawns` takes none) goes through `tryClaim` in `admit`, after `pace` and before
  capacity: ordinary holders are at most `leads`, all holders at most `leads + 1`, the extra place being for an urgent Issue
  (`issues.class = 'urgent'`), so an urgent holder never uses up an ordinary place. Otherwise the spawn is held with
  `hold: "claim"`, no account reserved, and looked at again every 30 s like `pace`. A place that frees goes to the oldest queued
  Issue by id (urgent ones first); only an Issue with a spawn still queued, waiting or starting counts as queued. A repo whose
  project has no row yet is held the same way: the tick syncs a named repo before it claims. A spawn for a closed Issue is
  refused (`IssueClosed`, nothing stored), and a queued or waiting one whose Issue closed fails in the tick's sweep. A spawn without an Issue (waves, fan
  workers, `rd`) takes no claim. The session of a spawn is not bound to its Issue here (Wave 3 does it with the lead).
- **Release.** `releaseClaim` is what finalize calls (Wave 4); until then `releaseClosed` in the tick's project pass gives back the
  claims of closed Issues, and the held claim of an Issue whose every spawn failed (no lead ever ran; `factory spawn requeue` asks
  again), before the spawns are claimed, so the next Issue is promoted in the same pass. The sweep and `requeueSpawn` run under the capacity
  lock like an admission; a requeue of such a spawn gives the place back first.
- **Read.** `GET /projects`, `GET /projects/:name` (token and socket), `POST /projects/sync` (token); `factory project list|show|sync`.

## 10. Jobs

A job is a small TypeScript module with a schedule. Code does the looking, an `agw` workflow writes up and groups
what it found, a lead does whatever needs understanding. A green run spends zero tokens. A job never edits a repo;
anything that needs a change becomes an Issue.

| Job | Probe | Opens |
|-|-|-|
| deps | outdated packages, release age, changelogs | one upgrade Issue per group that moves together; majors wait ≥ 14 days |
| docs and agent setup | AGENTS.md drift and size, skill count, resident tool tokens | upkeep when drifted or over budget |
| code health | `make quality` over the week's changes | one batched upkeep Issue per project |
| infra | disks, certs, backup age, a weekly restore test, containers, memory | an incident with its runbook |
| briefing | the night's closed, stuck and waiting Issues, decisions, capacity | the morning briefing to iris |
| changelog | the day's lead summaries | an entry per change in the brain page and Argo's project page |
| scorecard | the factory's facts plus monitors, git and usage, never the leads' reports alone | numbers on Argo; a measure off target for two weeks opens an upkeep Issue |

Later jobs get built when they have a consumer: perf baselines after a regression reaches the owner, scorers and
tuning at 50 closed Issues, security audits per repo at about 2,000 changed lines.

## 11. Surfaces

| Surface | Talks to the factory | Gets |
|-|-|-|
| **iris** | factory API | the live glance at fleet, waves and quota; decision cards and push (APNs waits on the Apple developer enrolment; until then cards go through `ask-human.sh`) |
| **Hermes** | factory API | "do X" becomes `factory issue new`; "how is X going" reads the factory. It never implements |
| **Argo** | reads `factory` views directly, forwards intents to the API | depth: queue history, scorecard, cost per Issue |
| **Agents** | `factory` CLI | §2's small block |

### The factory door (owner decision 2, 2026-11-01)

Today every alert goes to Slack only. The door makes a real alert one Issue, from the tailnet, before F3's dedup, settle and
runbooks exist: an alert-born Issue only queues until F2 Wave 4 (evidence and the hold) is live (decision 3).

- **A process of its own,** `packages/door`: one route, `POST /alert/<source>`, loopback only (`FACTORY_DOOR_PORT`, default 8796);
  `tailscale serve` terminates TLS on the mini's tailnet name and the ACL gives that port, and nothing else, to `tag:homelab` and
  `tag:vps`. A bearer token per source (`~/.config/factory/door-tokens.json`, mode 0600, `factory door token new <source>`) is
  checked in constant time, the body is capped at 64 KiB as it is read, JSON only. Nothing is logged but a status line.
- **It holds no factory token and no database credential.** It posts one line to the server's unix socket (`POST /intake`, the
  hook's boundary, SF11: a compromised door has what a pane has, see the trust boundary in §3). The socket down is a 503 (Kuma retries); nothing is spooled.
- **A parser per source** is a pure function from the payload to `{ monitor, event, status, title, facts }`: `kuma` and `hyperdx`
  (README of the package: the template the vps repo uses). The payload is data. Nothing in it picks a repo, a role, a path or a command.
- **The registry** is `factory.door_routes (source, monitor, repo)` in the database, not in git: monitor names and repos are the
  owner's estate (`factory door route set|rm|list`, `factory door unrouted`, on the token API). The repo is checked like a spawn's
  (422), and a route into IuRoot is refused when it is set, as an alert's Issue is when it is filed: one policy, in `createIssue`.
- **`POST /intake`** (`issues/intake.ts`, socket only) files in one transaction, the route row locked so one monitor's alerts go in
  one at a time: (1) no route, no Issue, one `door_unrouted` row counts it (202: Kuma attaches every provider to every monitor, so this is
  the common path); (2) routed, an Issue of this monitor not closed, the event is a `signal` inbox row (key `door:<source>:<monitor>:<event>`) on it, `regression: true` when
  down (200); (3) routed, none open, down: `createIssue` (`source: alert`, key `<source>:<monitor>:<event>`, the route's repo) (201);
  (4) routed, none open, up: only the route's counter (202). A replayed event is one effect: the Issue's key, the inbox key and the
  counters' last event (a counter keeps only its latest event, so an older retry counts again). The event that created an Issue, and one that was a
  signal, are not filed again later, whatever became of the Issue. The key escapes `:` and `%` in the monitor, so two monitors never share one. A signal carries the
  alert's facts. An open Issue keeps its monitor until it closes, also when the route has moved to another repo.
- **Run:** its own LaunchAgent, installed and restarted by `make deploy` from the same release directory; `make verify` ends with
  the door's 401 to an unauthenticated `POST /alert/kuma`. A door that cannot start (no tokens file) warns at deploy and fails that line. The door restarts at every deploy: for
  the seconds it is down a POST is refused at the connection, and Slack still gets every alert, so nothing is lost that was not already
  only in Slack.

### The owner's line (owner decision 4, 2026-11-01)

Until now the factory reached the owner nowhere but `factory status` and the board. It now writes to Slack through Hermes, which only
delivers: a message is a template filled with facts, never a model's words (SF2).

- **The `Notifier` port** (`notify/port.ts`) has one call, `send(message)`, answering `ok` or an error and never throwing. `HermesNotifier`
  runs `hermes send --to <target> --quiet` with the text on stdin and a 10 s process timeout (`HERMES_BIN`; `FACTORY_NOTIFY_TARGET`,
  default `slack:#agents`: a channel name is no secret, and a message there never makes Hermes answer). `FACTORY_NOTIFY_TARGET=off` is the
  `NullNotifier`: rows are still recorded and count as sent, with the reason in `error`. The tests use a fake.
- **An outbox, never a port in a transaction.** `factory.notifications` (`key` primary). A rule that decides a message inserts its row
  `ON CONFLICT DO NOTHING` in the transaction that decides it (`ask` in `recordDecision`, parked and the hold in `applyEvent`), so a rolled
  back decision says nothing; the rules that read state (`notifyFailures`, the digest) run once a tick as statements of their own, and their
  keys make a replay a no-op. The tick then sends: claim and commit (at most 5 rows, `attempts + 1`, `next_at` = now + a 2-minute lease),
  call the notifier outside any transaction (the calls of one pass side by side, so a dead Hermes costs one timeout), record the result. A
  failed send is fenced by the attempt it belongs to (a send that outlived its lease cannot undo a newer attempt; a delivery is always recorded) and backs off 30 s, 60 s, ... up to 5 min; the fifth failure is `failed` (`failed_at`) and a line in `factory status` for a week. A
  crash between the send and its record leaves the lease to run out and the row is sent again: **at-least-once**, so a message may arrive twice.
- **What goes out**, one line each, `Issue <id> (<repo name>)` first, never a path or a hostname. Agent text (a question, a lead's reason, a
  monitor name) is cut to 200 characters, reduced to one line, scrubbed of token, host and path shapes and of a link's query and fragment (best effort, `notify/text.ts`) and fenced in
  “quotation marks” it cannot contain, so it reads as a quote and never as the factory's own sentence.

  | Key | When | Notes |
  |-|-|-|
  | `notify:ask:<decision id>` | a `decisions` row is new | names `factory issue answer <id> "<text>" --decision <n>` |
  | `notify:parked:<issue>:<revision>` | an Issue moved to `waiting` as `unreported` or `lead_gone` | a lead's own `block` or `park` is its report and sends nothing |
  | `notify:failed:spawn:<spawn key>` | a lead spawn failed for good and its Issue is open | a spawn has no time of its failure, so there is no window |
  | `notify:failed:<start_lead\|finalize>:<effect key>` | an effect failed 3 times and is still open | |
  | `notify:failed:door:<source>:<monitor>:<date>` | the door refused an alert (a route into IuRoot or outside the roots) | one per monitor per day |
  | `notify:regression:<issue>:<hold>` | a regression was sent back to a lead | |
  | `notify:digest:<date>` | 07:30 local | the morning reading, below |
  | `notify:test:...` | `factory notify test` | |

- **The away rule (FV Wave 4)** is decided at send time, in the claim's transaction, from presence ("Away and back" below): `notify:ask:*` (a decision, the `yours` tier)
  goes out unless the desk is present; `notify:digest:*` and `notify:test:*` always go out; every other message (`parked`, `failed`, `regression`) goes out only while the phone
  is present and the desk is not. Any other message is **`folded`** (`folded_at`, `folded_reason`; `status: folded` in `factory notify list`): it is never sent later, its
  facts are in the since reading, and its `next_at` is `infinity`, so a release that does not know the column never finds it due. A delivery wins over a fold made while the send was in flight (a lease that ran out): the delivery clears the fold, as a delivery is always recorded. Before the board reports presence the owner is always away,
  so only decisions and the morning reading reach Slack: intended. The rule reads the clock when the row is claimed, not when it was recorded.
- **The morning reading** (`renderMorning`, the 07:30 message) is the since reading's groups (below) for the window from `seen_at`, at most 24 h back, as plain text under 3000 characters (a list is cut at six
  items and 450 characters): Needs you, Shipped, Went wrong then recovered, Handled for you (counts), Still running (ids), Spend, and a count of the read-only area (a line says so when the fleet model was never built, so a reading with no asks does not read as a quiet night). A message is a template filled with facts (SF2):
  **no model text** (the headline paragraph stays on the board, and a reply ask's `short` is not used), agent words are cut, quoted and scrubbed (`notify/text.ts`), and an IuRoot item is a count only.
  It is due from `FACTORY_DIGEST_AT` (`07:30`, before noon, or `off`) in `FACTORY_DIGEST_TZ` (`Europe/Berlin`) until noon local time, once per local date (the key is the date): a server that was down at 07:30 sends it at start if it is before noon, and not at
  three in the afternoon.
- **The way back.** `factory issue answer <id> <text> [--decision <id>] [--id <call id>]` (`POST /issues/:id/answer`) files an `answer`
  event, bound to the question open at that moment when none is named, so a question asked later cannot take it (none open is a 409); the
  lead is told in a note. **Token API only, never on the socket**: a pane has no token, so a lead cannot answer its own question, and the
  answer is always the owner's (`answered_by = owner`). The CLI without `FACTORY_TOKEN` says so (exit 3). The one other way a question is answered is the factory applying its own expired default (§4); and a process of the same user that can run `secrets-run` can fetch the token, which is the perimeter as the trust boundary in §3 states it, not something this route can close.
- **Not built:** the app's toast. `hc` has no `notify` command (0.1.15: `hc --help` lists none), so there is nothing to call besides Slack.
- **CLI:** `factory notify list [--pending]` and `factory notify test` (the lead's proof: one line through the outbox and Hermes, exit 1 and the
  error if it did not arrive, also when the target is `off`). The test row is made already claimed (`sendNow`), so the tick cannot send it beside the caller.

### The fleet view (FV Wave 1, 2026-11-02)

One read model of the fleet that every surface reads instead of building its own (`docs/research/2026-11-01-fleet-view.md`, plan
`docs/waves/fv.md`). Wave 1 is the deterministic half; Wave 2 (below, "The digest") adds the model text: `short`, `headline` and the asks found
in a session's last message. Wave 3 (below, "Triage and actions") adds `tier`, `suggestion` and `actions` to every ask.

- **Shape** (`packages/contract/src/fleet.ts`, strict zod, `Fleet` in `index.ts`): `summary { working, idle, done, asks, staleAsks }`,
  `asks[]`, `repos[]` (`name`, `space`, `visible`, `git`, `plan`, `morePlans`, `sessions[]`), `unplaced[]` (live sessions with no repo of
  the model: outside every root, or in a directory that is no git repo), `quota` and `queue` as `factory status` has them, `errors[]`,
  `builtAt`, `fingerprint`. The counts are of the sessions listed under a repo (not `unplaced`): `working` counts `working` and `starting`, `done` the others hc reports `done`
  (the turn ended unseen), `idle` the rest alive (the three do not overlap); `staleAsks` are asks older than 24 h.
- **A snapshot, never built inline.** `FleetBuilder` (`src/fleet/index.ts`) builds off the tick: `tick()` calls `kick()`, which starts a
  build behind its back when 30 s have passed and none runs; `POST /fleet/refresh` (`factory fleet --refresh`, token only) builds now
  and waits. The model is one row, `factory.fleet_snapshot` (migration `021`: JSON, fingerprint, `built_at`), written by a short
  transaction of its own; `GET /fleet` (token API only) reads that row, 503 `not_ready` before the first build. Every read is
  bounded (`git` 5 s, `hc` and the queue script 10 s, plan files 256 KiB) and none runs in a transaction.
- **Failure is local.** A source that fails (hc, the human queue, a repo's `git`, a plan file) leaves its part as the last build had it
  (memory; empty after a restart) and adds a line to `errors[]` (a root that cannot be listed too; each repo's lines are merged in path order, so the fingerprint is stable); the rest of the model stands. Only the database part has no
  fallback: with nothing to fall back on the build fails, the stored snapshot stays and the tick logs it.
- **`NOTIFY fleet`.** `pg_notify('fleet', <fingerprint>)` in the snapshot's transaction when the fingerprint is not the stored one. The
  fingerprint is a sha-256 of the model without `builtAt`, `lastActivityAt`, `readAt` and `sampledAt`, so the clock and a working agent's
  status messages do not make it move. A terminal the factory does not know has `since` = when the builder first saw it in that state
  (memory, seeded from the stored snapshot at boot; hc's own time moves with every message).
- **Repos.** Every git repo directly under `FACTORY_REPO_ROOTS` and `FACTORY_VISIBLE_ROOTS` (default `$HOME/IuRoot`; `off` for none)
  that has a `docs/waves/PLAN.md` or a live session; a session's repo is the one enclosing its spawn's repo, or its directory, both
  after `realpath`. `visible` is true for a repo under a visible root **or anywhere in IuRoot by place** (a path with an `IuRoot`
  segment, or under the real `$HOME/IuRoot`: the places the Issue refusal of an IuRoot alert checks), so `FACTORY_VISIBLE_ROOTS=off`
  does not make IuRoot's repos read as ordinary. It is the owner's read-only IuRoot view, never
  a spawn or Issue target of this model, and its text stays on the mini (the digest skips it, see "The digest").
- **Token only, never on the socket.** The model holds the text of IuRoot's repos, sessions and plans (titles, goals, commit subjects,
  hc messages, Claude's tab titles, branch names, attention lines, decisions, queue requests), and what a pane reads goes to its
  model. A filter over free text cannot be made tight (a first redacted view for the socket leaked through attention lines of closed
  Issues, decisions outside the roots, queue text with no place, error lines, symlinked spawns, notes to ended sessions and ticket-slug
  branch names), so `GET /fleet` and `POST /fleet/refresh` are on the token API only and the socket answers 404. `factory fleet`
  needs `FACTORY_TOKEN` and says so without one (exit 3, as `issue answer`). A consumer in a pane gets the fleet through an agent
  that holds the token, not through the socket. `visible` on a repo stays: it filters nothing here, it marks the repos Wave 2's digest
  skips. Attention-line ask ids (subject, verb, hash) replaced an earlier format: the first-seen times of factory asks restart once at
  the deploy.
- **Plans.** A session's plan is, in order: the `docs/waves/*.md` path its start text names (the spawn's prompt, or the longest argument
  of a terminal; the path named most often, ignoring what follows a `Never` on a line; relative to the spawn's repo or a root, `~/` to
  the home), else the `docs/waves/PLAN.md` found walking up from its directory to its repo (a worktree counts as its main checkout),
  else the repo's. Only a session that works counts for `running`: working, starting, blocked, stuck, walled, or waiting on workers or a
  deploy; an idle or done tab, or one waiting on the owner, does not. A path must resolve to a regular `.md` file of at most 256 KiB under a root, or it is not followed. The repo's
  `plan` is the one a live session works (its own `PLAN.md` first), else its `PLAN.md`; the others are `morePlans`. Headings
  `## Wave <n> — <title>` with `<!-- short: … -->` and `<!-- status: <word> [date][, text] -->` (`done`, `active`, `pending`,
  `scheduled` or `later [until <date>]`; no status is `pending`, another word `unknown`). `lastTouched` is the file's last commit (its
  mtime when git has none). States: `running` (a live session works it), `done` (every wave), `stale` (an active wave, untouched
  3 d), `scheduled` (nothing active and the next wave owner-timed, undated or dated ahead), else `planned`. For a visible repo a missing
  `short` is the title cut at 8 words. Only `## Wave <n>` headings are waves; any other `## Wave …` heading is ignored, silently. Headings may use `—`, `–`, `-`, `:`, `.` or nothing after the number, and files may be CRLF.
- **Sessions** are the factory's (`buildStatus`) and hc's Claude Code terminals (`terminal.list`, the RPC behind `hc ls --json`),
  merged when the terminal's address is the session's pane or its name or `factory.key` label is the session's id; a terminal the
  factory does not know (an `rd` session, IuRoot's) is its own entry, its state from hc's status, its parent through the parent
  terminal's name. A session outside every root is left out. `wave` is the `Wave <n>` its start text names, when its plan has it.
- **Asks** (deterministic sources only; `id` is `<source>:<key>`): `hc:<session>` (hc `blocked` for 2 min from hc's own status time, kind `permission`),
  `wait:<session>` (a declared wait on the owner, `question`), `factory:<subject>:<verb>:<hash>` (a `factory status` attention line keyed by what it is about, `stuck:<session>`, `note:<id>`,
  `spawn:<key>`, `notification:<key>` or `issue:<id>:<kind>`, plus a short hash of the line with its digits removed: a counter such as
  `for 5 min` does not change the id, two different lines of one subject do not collapse), `decision:<key>` (an open decision of an open Issue,
  `question`) and `queue:<id>` (the human queue through `ask-human.sh list --json`, `human`; the script is dotfiles', at
  `FACTORY_ASK_HUMAN`; a script that does not print the JSON array yet is an `errors[]` line). An ask with no time of its own (hc, a wait, an attention line) has the time of the first build that saw it, kept across builds and
  restarts. Oldest first. **Machine failures are not asks** (`isMachineNoise`; they stay in `factory status`): a note to a terminal the model no longer has or whose delivery is `unconfirmed`, a failed
  spawn whose agent is a working session, a kept-worktree line of an Issue that is not open, and `Issue N waits for the claim`. A `factory:` ask older than 7 days expires
  (left out, its time kept in `fleet_ask_seen` as a listed row, so it does not return as new, also after a restart); the queue, decisions, hc and waits never expire here.
- **CLI.** `factory fleet [--format json|plain] [--refresh]`: plain is the summary line, the asks, then the repos with a running plan
  and their sessions, then the errors.

**The digest (FV Wave 2).** `src/fleet/digest.ts` (the pass, the cache, the one `agw digest` call), `digest-model.ts` (what the digest may read, and what its
cache adds to the model), `transcript.ts` (the last reply of a session). The factory never calls a model (SF2): a pass is one `agw digest`
call, like Classify's `agw factory-classify`, off the tick and outside any transaction.

- **A pass** starts after a snapshot build when `FACTORY_DIGEST_EVERY` (default `5m`, `30s` to `24h`, `off`) has passed since the last. The
  items: a plan or wave heading with no `<!-- short: … -->` (kind `heading`; one item per heading text, whichever plan has it), a live
  session the factory knows (`session`: its tab title, role, repo, plan, wave and the end of its last message; a headline), and the last assistant message of
  a session whose turn has ended (`reply`: "does it ask the owner something?"). An item's fingerprint is the content it would send; one equal to
  its cached answer costs nothing. The changed ones go in **one** call, at most 64 items and 120,000 characters (agw's limits, counted in UTF-16 units; more is refused, never cut),
  oldest answers first; the rest wait for the next pass. Texts are made well-formed before they are hashed, sent or stored (no NUL, no lone surrogate: jsonb refuses both), and every cut keeps a surrogate pair whole. Model text that is stored loses bidi overrides, zero-width spaces and control characters (removed, never replaced by a space) and keeps joiners and variation selectors.
- **Once per turn.** A session's headline and reply are made when its turn count has moved *and* its turn has ended (`idle` or `waiting`); a turn that is still running keeps the
  last headline and has no reply ask. After the transcript is read the session is looked at again: one that went on meanwhile (another turn, or running) is skipped this pass.
  The same words in a later turn move the cached turn without a call. A terminal only hc knows has no turn count or transcript on record and gets **no** digest headline: its tab title is shown as is.
- **The call's lifecycle.** `agw digest --format json --idempotency-key factory-digest-<batch hash>-<attempt>` with the items on stdin. No short kill: the process has a
  hang guard of 30 minutes (`rules/agent-limits.md`); `agw` itself answers "pending" (exit 10) with the run's id after its own wait budget.
  - **One run per batch.** The attempt is the count of that batch's runs `agw` ended for good (`failed` or `cancelled`, journalled with `terminal`); nothing else moves it. A hang, a kill by the guard or an exit with no word on the run says nothing about the run, so the next pass asks again under the same key and `agw` returns that run: never a second paid one.
  - **Pending is not a failure.** The run's id and its batch are kept (`factory.fleet_digest_pending`, one row, migration `023`); while it exists every pass only runs `agw run wait <runId>` (a new heading waits), and when it ends its own batch is stored. A wait that fails without a word on the run is journalled as a failed pass each time; the third in a row, or `agw` saying the run is unknown (exit 4), ends the run as failed. `agw` saying it failed or was cancelled ends it at once.
  - **Backoff** (`factory.fleet_digest_backoff`, persisted, for the turn an item was for): a call that failed as a whole (whatever the reason, a refused transaction included) gives every item of it a flat 15 minutes; a batch that failed twice in a row is retried in halves (after the healthy items) until a poison item stands alone. An item whose own answer came back as `{id, error}` (or that the database refused) waits 5 minutes, doubled with every error in a row, at most a day. An answered item's row goes. An item that waits is not read: no transcript, no session lookup.
  - **Stored per answer.** The answers of a finished call are stored each under a savepoint, with the journal row and the cost in the same transaction: one answer the database refuses is that item's error, the others are kept and the run is not lost. A transaction that fails as a whole keeps nothing and is journalled as a failed call.
- **The cache** is `factory.fleet_digest (key, fingerprint, answer, at)` (migration `022`), keys `heading:<hash of the text>`, `session:<id>` and
  `reply:<id>`; every build reads it, so the text is in `/fleet` from the build after the pass. It survives a restart. A row nobody wants is dropped after 7 days (not on a build that could not read all its sources).
  `factory.fleet_digest_runs` journals each call (when, ok, items, failed items, cost as agw reported it).
- **The reply extract.** The transcript (`transcript_path`, only a Claude Code file `…/.claude*/projects/<project>/<session>.jsonl` after `realpath`) is read from its last
  512 KiB as data: the last `text` block of an `assistant` line after the last *prompt*, no tool call, no thinking, at most 4,000 characters (start and end when longer). Only a prompt somebody wrote starts a turn: a tool result (also with text beside it), a line
  marked `isMeta`, a compact summary, a skill's base text, system reminders, hook feedback, local command output, a task notification do not. An answer with
  `asks: true` and confidence `high` or `medium` joins `asks` as `reply:<session>:<turn>` (`source: reply`, its `kind`, `short`, and the end of the message as `text`, `at` the time the
  session went idle); a newer turn drops it at once, before the digest has read that turn. A session that already has an ask of its own (`hc:` or `wait:`) is **one** ask: the reply gives it its `short` and nothing else (its kind, actions and suggestion stay the deterministic source's), no second ask. An interrupt marker (`[Request interrupted by user …]`) ends the turn with no reply.
- **IuRoot never goes.** The feed is built by `scopeOf` and nothing else: no heading of a visible repo or plan, no session whose repo, spawn repo, directory,
  terminal directory or plan is visible (a session in an ordinary repo that works an IuRoot plan is IuRoot's), no session outside every repo. `applyDigest` gates by the same scope (the repos, plans and sessions it offered),
  so text is added to nothing else. Their `short` stays the plan's own comment or the heading cut at 8 words, their `headline` null, and the cache holds nothing of them.
- **Failure is quiet.** A failed call stores nothing and the model keeps the cached text. `factory status` shows `digest: N failed passes in the last 24 h` in
  its attention (only when N > 0; the fleet model leaves that line out of the asks). `factory fleet --format json` has `digest { enabled, pending, lastAt, lastError, days[] }`, the
  days UTC, newest first, each with calls, failed calls, items and `costUsd`; `digest` is not in the fingerprint, so a call that changes no text does not `NOTIFY`.
- **Not done:** the `visible` marker still filters nothing in the (token-only) model.

**Triage and actions (FV Wave 3).** `src/fleet/triage.ts` (the rules and the pass the build runs after the digest), `probes.ts`, `triage-store.ts`, `act.ts`. Migration `024`:
`factory.fleet_triage_log` and `factory.fleet_acts`. Deterministic rules only: the digest's text (`short`, a reply ask's `kind`) is shown and never read to decide a tier, and nothing moves an ask into `automatic`.

- **A tier per ask** (`automatic | one_click | hand_off | yours`) with `suggestion { verb, why, evidence, confidence }` and `actions[]`. In this order for a human-queue request: (1) the **business classes** (spend, irreversible data loss, Touch ID / password / a machine the owner must be at, other people, judged on the text and the command) → `yours`, no
  suggestion, only `deny` and `later`, whatever a probe would say (a probe is not even asked); (2) *already done*: an old (7 days) request whose **command** (`cmd`; the text is never read for a verdict) is nothing but `rm`/`rmdir`/`trash` and
  `mkdir`/`touch` on safe absolute paths, and a probe finds every path as the command would leave it → `one_click`, suggestion `resolve`, evidence the probe's answer; (3) a failed deploy gate (`Deploy gate [<repo>] … <sha> FAILED`)
  whose repo's default branch has moved past that commit (git, read-only) → `one_click`, `deny`; (4) older than 7 days → `one_click`, `deny`, evidence the date and age ("an old request is denied, never run with its stale command"); (5) else `yours`. Other
  sources: a `factory` blocker in an ordinary repo (not in IuRoot, no business class) is `hand_off` (`hand_off`, `later`); a session's `wait`/`reply` ask whose plan is `done` in an ordinary repo is `one_click` with
  `archive_plan` (evidence: the waves counted); a `handoff` ask (below) is `one_click` with `resolve` (acknowledge); everything else is `yours` (`later`, plus `deny` for a decision). A `one_click` ask with no suggestion left is `yours` (`hand_off` has no suggestion by design). A suggestion without evidence is never made.
  Only deterministic fields decide a tier (source, plan state, visibility, the text's business class); an ask's `kind`, which the digest sets on a reply ask, does not.
- **Probes** are read-only, bounded (5 s) and run in the fleet build, off the tick, in no transaction, at most 40 per build, answers cached 5 minutes. A path is looked at on a machine named in `FACTORY_PROBE_HOSTS`
  (`<name>=<ssh alias|local>,…`, none by default; a probe on a machine not listed says nothing): the machine the text names, else `macbook`, the machine the queue's commands run on. Remote probes are `ssh -o BatchMode=yes <alias> test -e <path>`
  with the path matched against `^(~/|/)[\w@+ ./-]*$` and quoted. A probe that cannot tell (unreachable, timed out) is no evidence. A command with anything else in it (an install, a pipe, a redirect, a substitution, a quote, a glob, a variable, a relative path, `..`) has no targets, and a machine the text names that is not configured is not probed (the queue's machine does not stand in for it). A build spends at most 15 s on probes and starts at a different request each time; an answer of "cannot tell" is cached 30 s.
- **Actions are intents** (`POST /fleet/asks/:id/act {intent, note?, until?}`, token API only, never the socket): only what the ask's `actions` offer now (409 `not_offered` otherwise), done once (a repeat is 200 with the first's result; an ask is closed by one of `resolve`, `deny`, `hand_off`, a second is 409 `already_closed`;
  `factory.fleet_acts`, unique per ask for those and for `archive_plan`), serialized per ask, followed by a fleet build so the next read shows it (a triage that fails still hides what the owner closed or snoozed). `resolve` and `deny` on a queue request call `ask-human.sh resolve <id> --as done|denied [--note]`
  (the script's help is read first: until dotfiles has `resolve`, the answer is 503 `unavailable` with the reason and nothing is recorded); **nothing in this wave runs a request's command**. `deny` on a decision files the
  owner's answer (`fileAnswer`, the same row `factory issue answer` writes) with the denial text. `later` hides the ask until `until` (default 24 h, at most 30 days; the build drops it, the ask keeps its first-seen time).
  `archive_plan` and `hand_off` are spawns (role `worker`, repo through the same `FACTORY_REPO_ROOTS` check as `POST /spawns`, never a visible repo): the brief for an archive is one commit moving the plan to `docs/waves/archive/`, made by the worker,
  never by the server; the brief for a hand-off carries the ask's text (and the owner's note) as data between tags that carry the text's own hash, so no text can close its block, and asks for a last line `Result: …`. Keys are deterministic (`fleet-archive-<hash>`, `fleet-handoff-<hash>`). A resolved, denied or handed-off ask is gone for good (its id is one occurrence).
  The result comes back as a new ask: when a hand-off's worker has ended, `handoff:<spawn key>` (`source: handoff`, `kind: note`); one that failed to start is the `spawn … failed` ask of `factory status`, again handable.
- **Automatic is bookkeeping only** (`fleet_triage_log`: kind, subject, what, why, evidence, `at`, `undone_at`; unique on `(kind, subject, fingerprint)`, so what the owner undid is not made again for the same fact): a stale plan marked
  (`plan_stale`; undo reads that plan as `planned` until its text changes), an ask folded under the newer ask about the same subject (`fold`: factory asks of one subject; queue requests whose text and command are both the same; the older leaves `asks` and the newer lists it in
  `folded`; it holds only while the newer one is listed), an expired note dismissed (`dismiss_note`: a factory note ask 24 h old). `GET /fleet/triage` lists the log, `POST /fleet/triage/:id/undo` takes a row back (201, 200 when already undone, 404). None
  of it runs a command, denies an ask, or touches the queue: a folded request stays in the queue.
- **CLI.** `factory fleet act <ask> <intent> [--note] [--until]`, `factory fleet triage [--undo <id>]`; the plain screen shows each ask's tier, suggestion and actions.
- **Occurrences** (`factory.fleet_ask_seen`): an ask is one occurrence while its source lists it; a build in which every source answered and that does not list it ends the occurrence, and a return is the next
  one (`occurrence` on the ask) with a new first-seen time. What the owner did (a close, a snooze, a hand-off, its spawn key) is of one occurrence, so a `stuck` session that sticks again days later is a new ask. The table is also
  what the builder restarts with for the first-seen time of every ask (also the ones the triage hid), so a restart does not make an old ask look new and turn a fold round. A build reads the acts it needs once (the listed asks'
  and the hand-offs of the last day), writes the new automatic decisions in one statement, and looks only at the unresolved hand-offs of the last day for their worker's end.
- **A queue write whose record failed converges.** `ask-human.sh resolve` exits 2 for every refusal; the adapter then reads `ask-human.sh status <id>` and, when the request shows a result (an earlier call, the owner's own), the act is
  recorded as the result it shows (`resolvedAs` done → `resolve`; denied or superseded → `deny`) instead of failing for good. A spawn's repo is also checked on its real path against IuRoot and `FACTORY_VISIBLE_ROOTS`, independent of the snapshot's flag.
- **Not done:** the digest does not rank within a tier (asks stay oldest first); a hand-off's result is the ended worker, not its last message, and is looked for one day.

**Away and back (FV Wave 4).** `src/fleet/presence.ts` (acts, the clock, the cursor), `away.ts` (the routes' logic), `since.ts` (the groups), `window.ts` (the headline paragraph); `notify/outbox.ts` (the away rule), `notify/digest.ts`
(the morning reading). Migrations `025` (`fleet_presence_acts`, `fleet_seen`, `fleet_windows`, and `folded_at`/`folded_reason` on `notifications`), `026` (a window can be `superseded`) and `027` (`fleet_windows.context`). Token API only, like `/fleet`: the groups hold IuRoot's text.

- **Presence from human acts only.** `POST /fleet/presence {place: desk|phone, act, until?}`; `act` is `focus`, `looked`, `board_click`, `unlock`, `memo`, `foreground` or `caught_up`, which alone takes `until` and needs it (a `caught_up` without one, or any other act with one, is 400) (`memo` and `foreground` only for the phone: a voice memo comes from the couch or the road, so it
  says nothing of the desk). Each act is a row (kept 30 days). **Derived by the clock, never stored:** the desk is present while its last act is under 45 min old, the phone under 10 min; `away` is neither (also before the first act), `awaySince` the later of the two expiries.
  `GET /fleet` carries `presence { desk {at, present}, phone {at, present}, away, awaySince, seenAt }` from the read, never from the snapshot (so it is not in the fingerprint). Nothing else moves presence: no hook event, prompt, note, `rd say` or HID idle
  (those routes do not reach this module; a test pins a note and an event leaving it at `away`).
- **`seen_at`, one owner-wide cursor** (`fleet_seen`, one row), moves forward only: on `caught_up` from any place, which carries the `until` of the since reading the owner saw (`GET /fleet/since` answers it, and `factory fleet since` prints it for the owner to pass on to `fleet seen --until`) and moves the cursor there, at most to now, so what landed after that reading is in the next window; and on an act (`POST /fleet/asks/:id/act`, which also records a presence act for the place it names, `place` default `desk`: `board_click` for the desk,
  `foreground` for the phone) when that act leaves no other ask of the open window (raised since the cursor, at most 7 days back) in Needs you, to the time the snapshot was built (at most now). A repeat of an act records nothing. The cursor waits for a snapshot the act's own build refreshed with every ask source answering (hc, the database, the human queue, the digest's reply asks: the builder's own `askSourcesAnswered`): after a failed or partial build the act still counts as the person's presence, and the cursor stays.
- **`GET /fleet/since?t=<iso>`** answers from the stored snapshot and recorded facts, **never from git and never from agw**. `t` defaults to `seen_at` (24 h back when the owner has never caught up), is cut to 7 days back (`clamped`), and a later or malformed `t` is 400. Groups:
  *Needs you* (asks with `at` in the window, `yours` first, whole `FleetAsk` with tier, suggestion and actions); *Shipped* (Issues closed `done`, commits of each repo's default branch, plan waves with a dated `done` in the window); *Went wrong, then recovered*
  (one collapsed line: a spawn that started on a later try, an Issue effect or a message that went through on a later try, a digest that failed and then ran; the headline's own calls are left out, they would change the facts they are made from); *Handled for you* (the triage log's rows of the window, with the
  undo id while not undone, and the owner's acts); *Still running* (the snapshot's sessions, with how long the factory's own have run); *Spend* (per account the weekly share at the window's start, the nearest reading at or before `t`, and now; the digest's own cost in the window).
  **Every line has a `source`**: `table:key` (`issues:12`, `spawns:<key>`, `issue_effects:<key>`, `notifications:<key>`, `fleet_triage_log:<id>`, `fleet_acts:<id>`, `fleet_digest_runs:<first>..<last>`, `quota_readings:<from>..<to>`, `events:<session>`,
  `fleet_snapshot:<ask id>`), `git:<repo>@<sha>` or `plan:<repo>/<path>#wave-<n>`, so the gate can trace it. `visible` marks an item of the read-only area; one that nothing places (a queue request, an unplaced session, a triage row it cannot tie to an ordinary plan or ask) counts as visible.
- **Commits** are the snapshot builder's: `FleetGit.recent` is the last 20 first-parent commits of the default branch (`GitReader.defaultHead`, one `for-each-ref` call for `origin/main`, `origin/master`, `main`, `master` in that order, shared with the deploy-gate triage; a repo whose commits cannot be read (a timeout or any git error) still has its branch, dirty bit and last commit read; only `recent` falls back to the previous build's (also after a restart: seeded from the stored snapshot), with a `git <repo>: …` line in `errors`, and the since reading lists the repo in `incomplete`, so the reader knows Shipped may miss commits there (the morning message says it as a count). That is the whole guarantee; the cursor is not held back by it; sha, subject, committer date), read with the other bounded git in the build, off the tick and off the request path.
- **The headline paragraph** is the only model text: one `agw digest` call of kind `window` per distinct window (`{id, paragraph}`, at most 60 words), its input the groups' **non-IuRoot** facts as a template (an IuRoot item is a count, never its text: the same `Places` as `scopeOf` decide; the triage and the owner's acts are counts by kind; nothing that moves with the clock is in it, so
  equal facts are one call), cut to 6,000 characters, cached by the facts' hash in `fleet_windows`. `GET /fleet/since` ends at `min(now, the snapshot's build)` (its `until`: an ask raised after the last build is in no reading the owner can catch up to), and answers `headline {state: ready|pending|failed|none, text}`: a missing window is queued and answered `pending` (`none`: nothing ordinary to say, or `FACTORY_DIGEST_EVERY=off`). The tick starts a pass when a window waits
  and none runs: one run in flight (a run agw has not finished is only waited for, `agw run wait`, and let go after three waits that fail without a word on it), the idempotency key is the facts' hash and the count of that window's runs agw ended for good, a failure backs the window off 15 min doubled at most to 6 h (an answer that came back as an error, and a run still pending after 2 h, count as runs agw ended: the retry is a new run under a new key; a request (made under a table lock, so requests take turns) supersedes every other window that still waits, queued or backing off (`superseded`, never started): only the newest is started, it is the one about to be read; the running sessions are in the facts by id, not by headline),
  and at most 48 window calls per 24 h. The calls are journalled in `fleet_digest_runs` (`batch_hash` `window:<hash>`) with their cost, so the digest's spend per day counts them. Only the default reading (no `t`, from the cursor) queues its headline and supersedes others; a reading with an explicit `t` shows a paragraph already made, or `none`, and writes nothing, and an explicit `t` later than the reading's `until` is cut to it (an empty reading). Requests take turns under an advisory lock (`locks.ts`); a request for a row that exists refreshes its context while it waits and makes it the newest request again, and writes nothing when the row is already the newest, its context is unchanged and nothing waits; the pass claims the row (`pending`) before the call, so a window that was let go meanwhile is not started (a pending claim with no run id that this process is not making a call for is a crash's: the window is queued again at once with nothing counted; a start that throws before the call is a failure with its backoff, and if even recording that throws the claim is released). The running sessions' headlines go to agw as the item's `context`, outside the hash (IuRoot ones are never in it). `caught_up` with no fleet build to have read is 409 `no_build` and records nothing (the CLI exits non-zero). A rollback past `026` leaves a `superseded` window pending, which harms nothing: it is a headline only. The first desk act after the desk was away queues its window at once and starts the pass, so the board's card has its paragraph by the time it is read.
- **CLI.** `factory fleet presence <desk|phone> <act> [--until <iso>]` (`caught_up` needs `--until`, no other act takes it), `factory fleet since [--t <iso>]`, `factory fleet seen --until <iso> [--place desk|phone]` (caught up; `--until` is required: the until `fleet since` printed for the reading that was seen, never a default); `--format json|plain`; token only (exit 3 without `FACTORY_TOKEN`). `factory fleet` prints the presence line.
- **Not done:** the board's card and Iris' use of the routes (dotfiles, Iris); presence is not pushed over `NOTIFY` (the board reads it with `/fleet`); the Kuma and deploy-gate facts the proposal lists are not yet in the groups (a failed deploy gate is a queue ask, so it shows under Needs you).

**The reaper (FV Wave 5).** `src/fleet/reaper.ts` (the guards and the pass), `git.ts` (`dirtyEntries`, `mergeProof`, `branchOf`), `sources.ts` (`HcCloser`, which `HcTerminals` implements). Migration `028` (`fleet_triage_log.kind` gains `reaped`). It closes a finished worker session so the Herdr app's tab list stays a list of what is alive; it never touches work.

- **Who is closed: all of these, checked in the build** (off the tick, git bounded at 5 s, no transaction around a port). A Claude Code terminal whose `cwd` **as hc reports it** (every guard reads hc's directory, not the factory's record) is `<repo>/.claude/worktrees/<name>[/…]` of a repo directly under `FACTORY_REPO_ROOTS`; the factory's recorded directory for the session must be in the same worktree, else the session is kept with "cwd moved" (never a main checkout, never a repo or directory `Places` calls visible: IuRoot is not looked at and not listed); a session that is not an open Issue's (`sessions.issue_id` of an Issue that is not `closed`, or anything in a `lead_worktrees` path of one); the derived state `idle` and hc's status `idle` or `done`, with its last activity (the later of its last event and hc's status time) at least 2 h old (an age that is not a number keeps it); the worktree clean (`git status --porcelain`, untracked files included, ignored ones not); the branch merged; the parent waits on nothing of it (no parent, a parent the model does not list, or one not in `wait=workers`: only a factory-known parent has a `wait`, an hc-only parent is never held back).
- **Merged** is read from the worktree's own `HEAD` and from the commits made in it. Work is every commit its `HEAD` log (`logs/HEAD` in the worktree's git dir) shows: `commit`, `commit (amend)`, `cherry-pick`, `revert`, `rebase (pick)` and the like (a merge commit made to bring the default branch in is none, and a commit an amend replaced is not counted). None at all is **nothing done** ("no commit made here", its own kept reason, never "not merged"): a branch still where the worktree was cut proves nothing; no log is kept too. `HEAD` must be in a default ref that exists (`origin/main`, `origin/master`, `main`, `master`; a merge in any counts), by commit (ancestor), by patch (every commit up to it has an equal patch there, `git cherry`) or by tree (its tree equals the tree of a commit among the last 300 on the ref's first-parent line, a squash merge); **and every commit made here that `HEAD` no longer holds** (a reset or checkout moved off it) must be on the default branch by commit or by patch, else the worktree is kept ("own commit X not on the default branch"). A head with no commit shows as a dirty worktree and is kept. Anything else has a commit the default branch lacks and is unmerged.
- **Closing** is `HcCloser.close({address, cwd})`: `terminal.get` again (still live, still Claude Code, still idle or done, still that directory), `terminal.kill`, `terminal.rm`; a terminal already gone or finished (`not_found`, `finished`) is what was wanted, any other refusal of the kill, a timeout or a dead process is an error and no `rm` follows. A terminal that does not run Claude Code any more is refused: when hc reports a foreground program that program decides (it is `claude`, or `node`/`bun` runs a script named `claude`; an editor with a file called claude is not), else the status app, the program or Claude's session label say. The fleet list's own `claude` flag is broader on purpose (status app, foreground, argument or label: the fleet must not lose a session it can see), and the judge gates on the strict test (`closable` on the terminal), so it never plans a close the closer refuses. A shell that took the terminal's place is somebody's work. By address, not by key: an `rd` session has no `factory.key`. herdr-core has no call that settles the app's tab (the app's document is opaque to the core; `doc.set` is not touched), so the app drops the tab when the terminal is removed. **The worktree stays** (`rd fan --clean` owns worktrees).
- **The log.** One `fleet_triage_log` row per close, `kind=reaped`, `subject` the worktree path, `fingerprint` the terminal's address and its idle time (the unique key), `what`, `why` ("Not undoable: the terminal is gone (the worktree stays)"), `evidence` (`idle since <iso>; <merge proof>; <the parent's state>`). It shows under "Handled for you" (`kind: reaped`, `undoId` null, never `visible`), and the morning reading has one line, "Closed for you: N finished worker sessions". `POST /fleet/triage/:id/undo` on one is 409 `not_undoable`. The row is written **before** the close with `payload.state = 'closing'` (hidden from every reading) and settled after it: a close that succeeded drops the state, one that did nothing (`NotClosed`: the terminal moved on, or the core refused the kill) deletes the row. A close that may have half happened (a timeout, a `rm` that failed after the kill) or a restart between the row and the close leaves the row `closing`; the next pass asks `HcCloser.finish(address)` (never kills): gone or finished (removed) settles it as closed, still running deletes it. So there is never a close nobody wrote down and never a row for a terminal that still runs. One window is accepted: a kill that timed out and that the core carries out late is found `live` by the next pass, which takes the row back, so that close has no row (the terminal is gone, the worktree stays). A `closing` row whose terminal is gone is settled as closed whoever ended it.
- **`/fleet` carries `reaper { mode, closed[], kept[] }`.** `closed` is the last 24 h of the log (`dry: false`, `logId`) and, in `dry`, what would be closed now (`dry: true`, `at` null). `kept` is an idle worktree session that holds something: `{session, repo, why}` for an unmerged branch ("N commit(s) the default branch lacks"), a dirty worktree, or a git that could not say. Kept items are no asks and nothing is pushed for them. `GET /fleet/since` reads the reaped rows with a limit of their own, so a night of closes never pushes the undoable triage rows out. A session the other guards exclude (a main checkout, an Issue's, a parent waiting on workers, under 2 h) is neither closed nor listed; one whose hc directory and the factory's record are in different worktrees, or one is a main checkout, is kept ("cwd moved") unless its parent waits on workers. A snapshot from an older release reads `mode: off`.
- **The switch** `FACTORY_REAPER=on|dry|off` (default `dry`; in `env-file.sh`'s allowlist, read at launch). `dry` closes nothing, ever: it kills nothing, removes nothing, writes and rewrites no row; unsettled closes it finds are a line in `errors` ("wait for FACTORY_REAPER=on") and, after an hour, an `unsettled` entry. `off` reads no git and judges nothing; it reads the database only for the closes left unsettled (500 at most, oldest first, the same rows the reconcile takes), and those over an hour old show in `reaper.closed` with `unsettled: true` in every mode (a close started and never confirmed is visible, never hidden). At most 5 closes a pass, oldest idle first; a close that fails is a line in `errors` (`reaper: <session> was not closed: …`) and tried again at the next pass (a failing one goes behind the others, so it cannot starve them; the count lives for as long as hc lists the terminal).
- **When the closes run.** The build judges (git and the database, no port) and stores the snapshot; the closes follow it, one pass at a time, **not inside the build** (`refreshNow` and the next build never wait for them): first, only when the build saw unsettled rows, those (`finish`; a terminal that still runs has its row taken back only once the row is 10 min old; younger it stays `closing`), then up to 5 closes (`on` only). **No new step starts after 60 s** (a step already running has its own 10 s limits); the rest waits, with a line in `errors`. What a pass has to say (a failed close, the spent time) is carried into the next build's `errors`; a closed session leaves the model with the next build (30 s). A plan made while a pass still runs is dropped. A build in which hc or the database fell back to an older reading closes nothing (it would act on a stale list): that is read from the sources' own fallback flags, not from the error lines, so the decisions-cap note does not stop it.
- **Git's answer for a worktree stands for 2 min** per terminal, kept or eligible (a `dry` reaper does not ask git again on every build); right before a close git is asked again, and a worktree that went dirty meanwhile is a line in `errors`, not a close. The branch name is read only for a branch that is not merged.
- **Rollback is not a pure expand.** The previous release does not know the kind `reaped`, and its strict `/fleet` reading rejects the `reaper` key (and `unsettled` in it) until it has stored a snapshot of its own. In this order: set `FACTORY_REAPER=off`, restart and see `mode: off`, copy the `reaped` rows if the record matters, `DELETE FROM factory.fleet_triage_log WHERE kind = 'reaped'`, wait for one build (a snapshot written while unsettled rows existed carries them), then roll back the code.
- **CLI.** `factory fleet` prints a `REAPER` block (mode, counts, a line per closed or kept session); `factory fleet triage` lists the `reaped` rows.
- **Not done:** a branch that was rebased and then squash-merged is kept (the commits it had before the rebase are not matched to their rebased copies); no call settles the app's tab (above); a parent known only to hc is not asked whether it waits on workers (hc has no such fact); no live proof of `on` against the real core in this wave (`HC_E2E` does not cover the reaper's close).

Intake polls: Kuma, Beszel, Docker on the three hosts, HyperDX alerts and error clusters, GitHub issues and checks,
RollHook deploys, failed launchd jobs, CrowdSec, TickTick. Polling also catches a missed recovery on the next read.

**Dead-man.** The factory's health carries loop lag, last tick and a database write, and Kuma watches it through
its door (A3). Until that door exists, the factory pushes a heartbeat. Kuma alerts through its own channel, the one
alert outside the factory.

**Telemetry.** OpenTelemetry to ClickStack's authed tier, one trace per Issue. Usage stays in the `usage` schema.
`usage` owns the session entity for every lane; `factory.sessions` holds only what the factory started. They join on
the Claude session id, which gives cost per Issue without the factory writing usage rows.

**Backups.** A nightly `pg_dump` to the homelab and a weekly restore drill, from F1. Lead transcripts are archived to
the homelab.

**`agw` workflows the factory will need,** each with an eval set, built in agent-workflows when its station is
built: classify, dedup judge, brief wording, learnings, changelog, briefing. `agw llm classify` and `agw triage` exist
and are the starting points, not the answer.

## 12. Data model

Schema `factory`. Sessions and the queue land in F1, the rest in F2 and later; the spike builds a slice of the first
group.

| Table | Holds | Track |
|-|-|-|
| `sessions` | pane, worktree, Claude session id, transcript path, repo, role, parent, account in effect, model, effort, nullable `issue_id` (F2) | F1 |
| `events` | every hook and witness fact, unique key, payload, seen at | F1 |
| `spawn_requests` | key, repo, role, prompt, tier, effort, requested at, `resume_at`, account, resulting session; `fork_session`, `fork_archive` for a fork of an archived session | F1 |
| `queue_scopes` | scope, state (`run`, `pace`, `drain`), reason, who, when | F1 |
| `quota_readings` | account, 5-hour and weekly use, reset times, read at | F1 |
| `prompts` | prompt id, session, text, typed at, delivered at; a lead's brief is one, source `brief`, id `issue:<id>:brief:<attempt>`, recorded `delivered`, written in the spawn's own transaction | F1 |
| `slots` | holder, lease, command | F1 |
| `projects` | every project: the last valid `project.yaml` (none: defaults) with its content hash and any error, make targets, pause flag; filled by sync since Wave 2 | F2 |
| `issues`, `issue_deps` | source, source key, repo, facts, kind, class, size, the lead's tier and effort, what Classify answered (`classify`) and when (`classified_at`), title, state, reason, outcome, attempt, parent, root cause, fix, summary, `wake_at` | F2 |
| `issue_inbox` | every event for an Issue, key, the session it came from, handled at, result, detail, error | F2 |
| `issue_effects` | what a transition asks of the world, key, attempts, error, done at | F2 |
| `issue_links` | Signal → Issue, Issue → Issue, who, why, whether it acted | F2 |
| `claims` | key `repo:<project>`, one row per Issue: urgent, queued at, held at (NULL while queued) | F2 |
| `issue_events` | phases, notes, orchestrator actions, state changes (`events` is the session store's name since F1) | F2 |
| `evidence` | per Issue: unique key, attempt, kind (`ui`, `service`, `infra`, `data`; the factory's own `hold` and `transcript`), link or payload, at, from whom | F2 |
| `decisions` | question, options, default, expiry, answer, who, when | F2 |
| `artifacts`, `comments` | plan or report as path@sha, comment threads | F2 |
| `signals` | source, source time, subject, fingerprint, payload | F3 |
| `job_runs` | job, slot, result, tokens spent | F3 |

`working`, `stuck` and `waiting` never appear as columns. Argo reads views over these tables, so a table can change
behind a stable view.

## 13. How we know it works

Neither the owner nor an agent says the factory works. These do:

**The golden set.** 959 labelled events from the old system. Every dedup rule or threshold change replays it; grouping
F1 may not drop below 0.889.

**Gamedays,** on scratch targets, each a gate:

| Gameday | Track | Pass |
|-|-|-|
| the server is killed mid-spawn and while sessions work | F1 | sessions keep working; on restart it reconciles; no duplicate effect |
| a usage wall, injected through `quota_readings` | F1 | the watchdog resumes the session once; nobody types "continue" |
| `drain` during a multi-wave run | F1 | the current wave finishes, the next does not start |
| a spawn with no capacity | F1 | it waits with a `resume_at` and starts by itself |
| the database restored from last night's dump | F1 | reconciliation; ids move past running panes; no duplicate effect |
| a lead stops with its Issue open and nothing reported | F2 | the hook sends it back |
| a seeded bug passes CI but breaks production | F2 | the production check catches it, or `make verify` after the hold reopens the Issue |
| a container stops | F3 | restarted by its runbook within 5 minutes of the grace ending; nothing reaches the owner |
| the server is killed mid-runbook | F3 | the runbook runs once to its end |
| every account walled with an outage open | F4 | settle and runbooks run; leads wait; nothing spills |

F1's own gate: an overnight multi-wave run across two repos with an injected limit wall and one `drain` needs no
owner "continue".

**Six numbers,** from SQL views the loop cannot edit, over 14 days:

| KPI | Target |
|-|-|
| non-business items that reached the owner | 0 |
| notifications to the owner | ≤ 2 a week plus the briefing |
| shipped changes whose deployed version lacked the merged commit at close | 0 |
| change failure rate within 7 days | < 5 % |
| time to heal an incident, median / p90 | ≤ 0.5 h / ≤ 4 h |
| green job runs that spent tokens | 0 |

**Edge cases handled in code:**

| Case | Handling |
|-|-|
| The factory deploys itself | stop, swap the release, start, health check; a failed check starts the previous release. The one automatic revert, because a dead factory watches nothing |
| The mini was down | open deadlines move by the downtime; missed job slots run once |
| A second copy starts | the advisory lock makes it exit |
| The factory is down when a hook fires | the event goes to the spool, replayed on start |
| A hook fires in the owner's own session | it exits at once: no `FACTORY_SESSION` |
| A runner restart moves a session to another account | the witness records the account in effect |
| A change edits its own checks | the review flags weakened tests; `make verify` and the probes run after the hold regardless |
| A merge absorbs an Issue in work | that lead pushes its work to a branch and drops the Issue as merged; its notes go to the surviving lead |
| Something else types into a `lead-*` pane | the factory alone owns them; the reaper skips them |
| A lead breaks a hook, the picker or `rd` | dotfiles and this repo carry a zero-token probe that runs each hook against a sample payload, so the break shows before the next lead starts |
