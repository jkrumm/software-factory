---
# Read by `agw review route` (the tier of a range) and by the reviewer. Globs are repo-relative.
none:        [docs/waves/**, docs/spikes/**, docs/evidence/**, docs/research/**, bun.lock]
sensitive:   [apps/server/migrations/**, apps/server/src/adapters/postgres/**, apps/server/src/main.ts,
              apps/server/src/domains/capacity/**, apps/server/src/domains/quality/evidence.ts,
              apps/server/src/domains/quality/gate.ts, apps/server/src/domains/quality/watch.ts,
              apps/server/src/domains/work/machine.ts, apps/server/src/domains/work/table.ts, apps/server/src/domains/work/events.ts,
              apps/server/src/adapters/leads/spool.ts, apps/server/src/adapters/git/repos.ts,
              apps/server/src/api/auth.ts, apps/server/src/api/policy.ts, packages/contract/src/spool.ts,
              apps/cli/src/hook.ts, apps/door/src/**, config/roles.json,
              scripts/deploy.sh, scripts/launch*.sh, scripts/env-file.sh, .env.tpl, .env.server.tpl, deploy/*.plist.template,
              .github/**]
nits: 3
---
# REVIEW.md — software-factory

What failure looks like here:

- **A session starts twice, or never.** Every effect has a deterministic key (pane names, prompt ids, comment markers);
  `hc-runner.ts` looks for a live `factory.key` terminal before it acts, `spawns.ts` and `queue.ts` claim and retry.
  A replayed tick must not spawn, prompt or post twice; a failing start ends `failed` after the 30-minute budget.
- **A port is called inside a transaction.** The tick claims and commits, calls the `Runner` with a process timeout, then
  records the result in a new transaction. `git` and `make verify` never run on the tick.
- **Admission lets too much through.** `domains/capacity/` (`admission.ts`, `claims.ts`, `accounts.ts`, `slots.ts`) decide drain, pace and
  account choice, and are decided again at every claim; a second implementation elsewhere is a second copy.
- **The trust boundary opens.** The token can start Claude Code with `--dangerously-skip-permissions`: `repo` and `space` must be
  inside `FACTORY_REPO_ROOTS` after `realpath` (`adapters/git/repos.ts`); the API is loopback only, bearer-authenticated, JSON only, 64 KiB
  (`api/auth.ts`, `api/policy.ts`); the door holds no factory token and takes the repo from `door_routes`, never the payload.
- **A hook breaks the session or loses facts.** `factory hook` exits 0 whatever happens (except the Stop send-back) and keeps
  stdout empty, because Claude Code injects it into context (one exception: a `session-start` with `source: compact` in an
  Issue lead's session, `lead-<issue>-<attempt>`, prints one re-read line); `src/hook.ts` imports only `node:fs` and `contract/spool`.
- **An Issue is shipped without proof.** `domains/work/machine.ts` is the one writer of an Issue's state; evidence, the gate and
  the watch (`evidence.ts`, `gate.ts`, `watch.ts`) must fail closed on a git that does not answer, and shipped means deployed.
- **Facts get stored as state, or a migration corrupts them.** State is derived from events, never stored. Migrations are
  advisory-locked, qualify every name, expand then contract, and never edit an applied one; advisory keys live only in `locks.ts`.
- **The public repo leaks.** Secrets, hostnames, IPs, tailnet names, account e-mails in tracked files; anything of a `visible`
  (IuRoot) repo, plan or session sent to a model or shown outside the token API (`scopeOf` decides). The factory never calls a model.

Skip: formatting, naming taste, lint-level remarks, test style. Evidence is always `file:line`.
