# Rewrite learnings

**Where the rewrite fell apart, what the plan changed, and the calls the orchestrator made alone, with the reason.**
Appended, never rewritten. Newest last. Owner answers go to `docs/decisions.md`, not here.

## Orchestrator's calls

- **2026-11-07, package 0: the old core moves to `legacy/` on the branch.** The new `packages/contract` collides with
  the old one by path and name, and the later packages port from the old code. `legacy/` is out of the workspace and of
  `make check`, readable as reference, and deleted in package 9. Master keeps running the old core untouched.
- **2026-11-07, package 0: the Postgres foundation is part of the skeleton.** The scenario harness needs a real server on
  a real database, and no package in `docs/rewrite.md` names the connection, migration runner or process lock.
- **2026-11-07, schema name: the new core uses schema `factory`.** At the cutover (package 9) the old schema is renamed
  `factory_legacy` before the new core's first migration, and the import reads from it. Reversible by a rename; it keeps
  one schema name for the factory as `AGENTS.md` says.
- **2026-11-07, open: "hold" is retired by `docs/language.md` (Watch: "Hold, in all three meanings") but used live by
  package 3's acceptance ("a memory hold names its reason") and triage's outcome `held`.** The retired-word check leaves
  bare `hold` out; package 3 settles the memory word (likely "a memory wait" with a named exit, per Wait).
- **2026-11-07, package 0 integrated.** Clean first pass, one review round. What it taught:
  - Elysia's `app.handle` 404s on a short host (`http://x/...`): Elysia reads the path at a fixed offset. Use
    `http://localhost/...`. The brief carried the researched form and was wrong; a research claim marked "derived from
    source reading" needs a test before it goes into a brief.
  - Bun's SQL ignores a unix socket in the URL: `DATABASE_URL` is TCP (test cluster on loopback, scram password).
  - `rd` puts `$HOME/.local/bin` first on PATH: the cutover installs the new CLI at `~/.local/bin/factory`.
  - The advisory keys are the old core's on purpose (old and new exclude each other); the migration runner refuses the
    old ledger, so the `factory_legacy` rename in package 9 is required, not optional.
- **2026-11-07, calls carried into later briefs:** AGENTS.md's old-core sections are rewritten in package 9, not
  piecemeal; a response the contract refuses (now 422 `invalid_response`, exit 2) becomes a 500 in package 8; `/health`
  gains tick staleness in the package that brings the tick (package 4 or 7); `FACTORY_LOCK_WAIT_MS` joins the settings
  allow-list in package 9; "only `app/` opens a transaction" becomes a boundary rule in package 1.
- **2026-11-07, package 1 start: an empty `CLAUDE_CONFIG_DIR` makes Claude Code use the cwd as its config dir.** The
  first start's `eval "$(claude-account pick ...)"` left the variable empty, so `env CLAUDE_CONFIG_DIR=` was passed:
  the session showed the trust and bypass prompts of a fresh config, ran on another plan than the picked Max account,
  and wrote `settings.json`, `projects/`, `sessions/` and more into the worktree. Caught within two minutes from the
  screen; killed, the junk removed, restarted. The start command now parses the dir and checks `test -d` before
  `hc run` (`docs/rewrite/state.md`). Always read the screen once right after a start.
- **2026-11-07, package 1 review: the reviewer drops files on its first pass.** Both packages so far had their first
  `/review` refused by agw because the reviewer's file list skipped core files (package 0: the renames and the lock;
  package 1: `table.ts`, `issue.ts`, the tests). The second attempt covered everything. The protocol works; expect one
  refusal per large range and do not treat it as a stall.
- **2026-11-07, package 1 calls:**
  - The third regression is a stall the steward ends (wake the lead, or raise a Decision), not a wait on the owner as
    in the old core: deterministic first, then a workflow, then the owner (product principle 1).
  - Issue ids are `issue_<n>` from a Postgres sequence, not UUIDv7: the owner and every surface speak of "Issue 286",
    and the cutover imports the old numbers. Sent back to the worker before the merge.
  - Only the unit of work and the migration runner call `.begin(`; `app/` gets the unit of work.
  - The machine has no claim wait: package 3 decides how a resumed Issue gets its repo's claim back.
  - The new event, wait and outcome words go into `docs/language.md` when the language is reconciled in package 9;
    until then report 1's state table is the reference the parallel briefs use.
- **2026-11-07, the empty account pick was a spill to the work account.** `claude-account pick --lane lead` prints
  `unset CLAUDE_CONFIG_DIR` when it picks `iu` (`--why`: `reason=spill`), randomly among picks while the Max accounts
  have headroom. Package 1's first start (about two minutes, then killed) ran on it. `rd` refuses to spill and so does
  the rewrite: the start loop re-picks until it gets a Max dir and does not start otherwise.
- **2026-11-07, packages 2 to 6: merges are made trivial up front.** `briefs/parallel.md` gives each package its
  folders, a migration number range (`0200` to `0699`), additive one-line edits to the shared files, and ports with
  honest stubs for every cross-domain need. Calls inside it: intake files, planning settles (`settled`), capacity
  admits (`admitted`); projects belong to planning and reach intake through a port; stop the line is a queue rule
  (package 3); cancel is package 8's owner verb; the tick that runs the outbox is package 4's or 7's, and `/health`
  gains staleness with it.
- **2026-11-07, package 6: parallel reviews collide.** `agw review prepare` keys its thread on the base commit, so the
  five workers off `fc5a8ac` abandoned each other's prepared jobs and one submit was refused against another worker's
  job. Fixed by `--thread rw-<package>` (sent to workers 2 to 5, now in `briefs/parallel.md`). Any future parallel
  fan-out off one commit needs its own thread per worker.
- **2026-11-07, package 6 integrated; carried forward:**
  - Decision and page passes run on two timers in `main.ts` (`FACTORY_CHECKPOINT_PASS_MS`) until package 7's tick
    takes them over.
  - Its settings (`FACTORY_DATA_DIR`, `FACTORY_CHECKPOINT_PASS_MS`, `FACTORY_CHECKPOINT_POLICY_FILE`,
    `FACTORY_NTFY_TOPIC`, `FACTORY_CONSOLE_URL`, `FACTORY_AGW_BIN`) join `scripts/env-file.sh` in package 9.
  - Accepted calls: the Judge never takes an irreversible option; a default must be reversible (refused at ask); a
    Decision with a default does not page (the factory settles it); a Decision is an artifact of kind `decision`.
  - For package 8: declare error bodies in the routes' OpenAPI responses so the CLI prints a refused form's fields on
    stderr; the brief text (package 4) must tell a lead that verdicts and answers arrive as notes and how to read an
    artifact (`factory artifact show`, `revise`).
- **2026-11-07, package 4 integrated; merge shape as planned.** Five shared files conflicted (`main.ts`, `api/app.ts`,
  the contract index, `boot.test.ts`, the generated CLI); every hunk was a union of two additive edits, and the CLI was
  regenerated. Carried forward:
  - The leads' tick (`FACTORY_TICK_MS`) runs spool replay, lost-lead follow and the outbox, and sets `/health`'s
    `tickAt` with staleness; package 7 folds it into the loops' tick or keeps it. `queueMovedAt` is package 3's.
  - For package 8: the brief's standing orders list only `close`, `defer`, `block`; `ship` (5) and `ask`, `artifact`
    (6) must be added; `factory issue show` must accept `issue_<n>` and the bare number (the compaction line names it).
  - For package 9: its settings list (report 4, open point 4) joins `scripts/env-file.sh`; the new core binds the old
    hook socket path and refuses to steal a live one, so the old server must be stopped first.
- **2026-11-07, packages 2, 3, 5: parallel packages finish with stubs, so integration is a second pass by the worker.**
  Package 5 brought its own outbox loop and lead stubs while package 4 had the real ones; package 3 owns the capacity,
  project and policy ports that 2, 4 and 6 stub. Merging those myself would mean editing code I did not write; the
  worker merges `rewrite` into its branch and replaces the stubs, then I merge. Calls: one outbox runner (package 4's
  tick) with quality's `start_watch` injected; one `FACTORY_TICK_MS`; the attempt's `base_sha` is the ship gate's cut;
  `Issue.repo` is the repo's directory name under the source root (intake's convention).
- **2026-11-07, package 2 integrated; carried forward:** for package 8, signal trust is still taken from the caller's
  claimed `from` until the token decides it (security), the door's health lines need a place on `/health`, and
  `factory door token new` is a verb to add; for package 4's brief (package 8 parity), an Issue's alert facts are read
  from `intake_signals`, the `filed` event carries only repo, title, kind and origin; for package 9, `launch-door.sh`
  and the deploy script name `apps/door`.
- **2026-11-07, package 5 integrated after its wiring pass.** One outbox runner (the leads' tick) now runs every effect
  with quality's `start_watch`; the ship gate's cut is the attempt's `base_sha`, and a commit older than the attempt is
  refused in production. Carried forward: `reportRegression`'s reopen half has no caller, because intake files a new
  Issue for a `down` after a close (the old core's rule, kept); package 8 or the first hygiene pass removes it.
  `FACTORY_CLOCK_OFFSET_MS` is a scenario-only setting like the internal test routes: package 8 removes or fences both.
- **2026-11-07, package 3 integrated; packages 0 to 6 are in (721 unit, 85 scenarios).** Found at its report: an
  Issue intake files stays `settling` until `planning settle` is called, and nothing called it. Package 7's brief now
  makes the triage loop settle every `settling` Issue (deterministic first, `factory-triage` for edges, the steward
  after a timeout), with a scenario from owner signal to admission. Carried forward: for package 9, Issues imported as
  `working` have no claim and block their repo until `resumeClaim` runs for each, and `deploy.hold` in `project.yaml`
  keeps its retired word until the files and schema change together; for package 8, a declared error body goes to
  stdout today (agw's contract wants messages on stderr), and the slot routes need the token.
- **2026-11-07, package 7 integrated.** One loop runner schedules every pass (leads, planning, watch, settle, send,
  steward, triage); a unit test fails on any other `setInterval`. Every agw ask is stored in `loop_calls`, so a replayed
  pass acts on the stored answer. `factory-steward`, `factory-triage` and the backward-compatible `factory-ask` are live
  in agent-workflows (97dac43). Calls accepted: the steward may raise a Decision from a stall (a machine cell added,
  the one change to `domains/work` since package 1); a `lead_gone` stall never gets a Decision (an answer cannot start
  an attempt); `factory.ask`'s route stays Haiku without thinking until something measures the change.
  agent-workflows' `make check` was already red on master (a clock-skew test); filed as Issue 292 on the running core
  rather than fixed inside the rewrite. Carried forward for after the cutover: a `watching -> waiting(blocked)` cell so
  a blocked checkout can stall; intake's pollers into the runner; cross-repo triage edges (the queue loop).
- **2026-11-07, package 8 integrated; packages 0 to 8 are in (941 unit, 195 scenarios).** One policy table decides who
  may call each route (owner, agent, machine, read), fails closed, and a test walks the OpenAPI document for a route
  without a row; signal trust follows the token. The read token never sees a work repo's words (one fail-closed rule);
  NL22 lifted the rule for agw only, and I kept the stricter read-token side. Known and accepted for now: the agent token
  is one token for every lead session, so a lead could call a verb on another Issue (as the old core allowed); per-session
  tokens are a later change. For package 9: Iris, Hermes, the Herdr board, `rd` and `ask-human.sh` need the changes in
  report 8; `FACTORY_AGENT_TOKEN` and `FACTORY_DOOR_TOKEN` must exist in 1Password; `verify.sh` and the gameday scripts
  call retired verbs; `AGENTS.md` contradicts the code until package 9 rewrites it.
- **2026-11-07, package 9a: the `factory` role cannot create schemas** (no CREATE on the shared database), so it can
  neither rename its schema nor create a new one; package 0's note was right. Call: no standing CREATE grant for an app
  role on a shared database; the rename and `CREATE SCHEMA factory AUTHORIZATION factory` are a one-time admin step on
  the vps side, written into the runbook with its undo. Least privilege beats a one-word grant that outlives its use.
