# software-factory

A factory for agent-built software, run by one developer on one machine.

Work comes in as signals (a failing monitor, an alert, an error cluster) or as requests (a GitHub issue, a
voice note). The factory merges duplicates, heals what a runbook can heal, and queues the rest against the
Claude Code subscriptions it has. When there is capacity, it starts an interactive Claude Code session that
owns the work from root cause to a verified production change, follows it through hooks, and closes and
learns from the result.

The factory runs the lifecycle in plain code. Every judgment that needs a model goes through
[agent-workflows](https://github.com/jkrumm/agent-workflows), and every change to a repo is made by
Claude Code.

Status: live on one machine. Start with [`docs/program.md`](docs/program.md) for the current state and
[`docs/decisions.md`](docs/decisions.md) for what was decided and why.

## Develop

Bun and a PostgreSQL install (`initdb`, `pg_ctl`) are needed; the tests run a throwaway cluster of their own.

```sh
bun install
make check   # format, lint, shellcheck, types, tests
```

## Layout

| Path | What |
|-|-|
| `packages/server` | the server: HTTP API, tick, `Runner` port, Issue lifecycle, read API, migrations (schema `factory`) |
| `packages/contract` | the zod schemas shared by the server and the CLI |
| `packages/cli` | the `factory` CLI: `status`, `issue`, `spawn`, `session`, `read`, `follow`, `fleet`, `hook` and more |
| `packages/door` | the door: tailnet alerts become Issues |
| `scripts/`, `deploy/` | release-directory deploy, verify, LaunchAgent templates |
| `docs/` | decisions, program, design, research, evidence, strategy, spikes |
