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

Status: planning and early build. Start with [`docs/decisions.md`](docs/decisions.md).
