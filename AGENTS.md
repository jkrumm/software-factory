# software-factory

The lifecycle server for agent-built software, CLI `factory`: signals become Issues, each Issue is owned by an
interactive Claude Code session in a herdr-core terminal from root cause to production evidence. Live on the mini since
2026-11-08; `docs/plan.yaml` is the open work.

**Start here:** `docs/product.md` → `docs/language.md` (the words) → `docs/architecture.md` (what is built) → `docs/decisions.md` (why).

## Rules

A rule a script holds names the script; the script's failure message says what to do. The detail behind each short rule
is in `docs/operations.md` "Rules behind AGENTS.md".

- **Public repo.** No secrets, hosts, IPs, tailnet names, internal URLs or account e-mails in tracked files. Placeholders:
  `<your-domain>`, `<see-1password>`. Secrets resolve at runtime through `secrets-run`. Work repos appear only as `WorkRoot`
  and `work-repo-N`. `scripts/public-scan.ts` (in `make check`) enforces; exceptions go in `scripts/public-scan.allow`.
- **The factory never calls a model.** Every judgment is an `agw` workflow through `apps/server/src/adapters/agw/`. No model
  SDK here. Interactive Claude Code in herdr-core only; never headless `claude -p`.
- **Layers:** `scripts/boundaries.ts` enforces them. `domains/*` import only `kernel` and their own folder and do no I/O;
  a domain reaches another through `app/`; only `adapters/postgres/unit-of-work.ts`, `migrate.ts` and `read/bounded.ts`
  open a transaction.
- **Facts are stored, state is derived.** An Issue's state is the result of its applied events, kept on the row because its
  `version` guards the write. A count or timer that `issue_events` can answer is never a column. `domains/work/table.ts` is
  total; `make check` fails when `docs/language.md`'s diagram is stale.
- **A repo is stored as its project name, never a path** (`repoNameOf`, `projectOf`).
- **Every effect has a deterministic key** (`kernel/keys.ts`), so a replayed pass never spawns, prompts or posts twice.
- **Never call a port inside a transaction.** A pass claims and commits, calls the port (every call has a process timeout;
  every port returns a `Result`), then records the outcome in a new transaction. `git` and `make verify` never run in a lead's pass.
- **Deploy locks fail closed:** an unreadable or uncreatable lock refuses the deploy (exit 75 / 1).
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, exit codes of `apps/cli/src/exit.ts`,
  never prompts. `apps/cli/src/generated/operations.ts` is generated; never edit it by hand. `rd --role` depends on
  `factory role get <role> --format json` printing exactly `{"role","tier","effort"}`; a role is a tier (`haiku|sonnet|opus`,
  never a model id) and an effort, in `config/roles.json`, changed only on measured data.
- **Tooling:** Bun, TypeScript strict, zod at boundaries, exact pins (no `^`/`~`; a 3-day release-age cooldown, never
  excluded). oxlint and oxfmt, no Biome. No Effect (NL11).
- **Who may call what:** `apps/server/src/api/policy.ts`. A route with no row is 403 for everyone, so its row comes first
  (`apps/server/test/policy.test.ts`). Only `GET /health` is public. When in doubt, the owner alone.
- **Trust boundary.** The owner's and orchestrator's tokens can start Claude Code with `--dangerously-skip-permissions`, so a
  spawn's repo must be inside `FACTORY_REPO_ROOTS` after `realpath`, or be one of `FACTORY_REPO_ALLOW` (`adapters/git/repos.ts`).
  A work repo of another organisation is admitted by name through the allowlist, never by adding its parent as a root.
  The API is loopback only; `FACTORY_REF=<branch>` deploys that branch, the same boundary.
- **The Console listener** (`api/console.ts`) answers 405 to anything but `GET`/`HEAD` bar its `WRITES` verbs, and can never
  start a session or cancel, reopen or file an Issue by its own words. **A new write goes through the Issue, never onto that
  list.** `docs/operations.md` "The Console listener".
- **Work repos hear only the owner** (NL18: no `project.yaml`, or `work: true`). The read token never sees their words
  (`read/surface.ts`). Their text may go to agw (NL22).
- **The door** (`apps/door`) holds only `FACTORY_DOOR_TOKEN` and takes the repo from `factory.door_routes`, never the payload.
- **Hooks: spool first, then post.** `factory hook` exits 0 whatever happens and keeps stdout empty, because Claude Code
  injects a hook's stdout into the session. Its import rule: `scripts/boundaries.ts`.
- **One contract.** Request, response and event shapes are zod schemas in `packages/contract`; the server and the CLI parse
  with the same one (a body that does not parse is exit 9).
- **Migrations** (`apps/server/migrations/NNNN_words.sql`) are expand then contract, and never edited once applied (a checksum
  refuses it). A number is used once.
- **Settings:** secrets in `.env*.tpl`; non-secret settings in `~/.config/factory/env`, allow-listed by `scripts/env-file.sh`.
- **Heartbeat names** on `GET /health` (`ok`, `reason`, `tickAt`, `queueMovedAt`) are read by a pusher outside this repo:
  do not rename them.
- **State words stay off screens:** `scripts/vocabulary.ts` and `scripts/retired-words.ts` fail on them.
- **The README states counts and lists;** `make docs-check` fails on a mismatch, so change it in the commit that changes one.

## Validate and ship

`make check-fast` is the lead's check: everything of `make check` that is not a test run, then the unit tests of the files
the branch changed. Outside CI it first applies `oxfmt --write`, so commit what it reformats. CI runs the full gate sharded.
`make check` (the whole gate, minutes in a test slot: `factory slot run`; "queued for a test slot" is a wait, not a hang) runs
locally only for a change to the test layout, the Makefile or CI itself. Reproduce one CI failure by running that suite alone
in a slot. Tiers and slot rules: `docs/operations.md` "Check tiers" and `docs/project.md` "Check tiers".

Changes land through a pull request (`project.yaml` `ship:`), conventional commits, no AI attribution. A lead lands with
`factory land` (merge lock, rebase, review check, push, CI, `make merge-guard`, merge). `--allow-red` is for the one change
that fixes a red master. `make deploy`, `make rollback` and `make verify` act on the mini only (`DRY_RUN=1` prints the plan,
`FACTORY_REF=<branch>` proves a branch live before it merges). Refusals and deploy variables: `docs/operations.md` "Merging" and "Deploy".

## Where to look

- Layers, the Issue machine, signals and triage, loops and agw, API and CLI, perimeter, what is not built: `docs/architecture.md`.
- A word, an event, a wait and its exit: `docs/language.md`. Why a rule exists: `docs/decisions.md`. Open work: `docs/plan.yaml`
  (the server files its rows as Issues). Writing a plan file: `docs/plan.md`; a `project.yaml`: `docs/project.md`.
- Before changing the Console listener, the CLI's credentials, the merge window, a deploy variable or a CI job, read `docs/operations.md`.
- Why a lead is briefed as it is: `apps/server/src/domains/leads/brief.ts`. What a reviewer treats as failure: `REVIEW.md`.
- The client pieces (Herdr glance mod, hook entries, `rd`'s contract, the Hermes `fleet` skill): `integrations/`, the copies this repo sources.

Update this file with the code it describes; a detail that is in the code or in `docs/` is deleted here.
