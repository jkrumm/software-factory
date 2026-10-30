# software-factory

The lifecycle server for agent-built software: it takes in signals and requests, merges duplicates, queues
work against the available Claude Code subscriptions, starts interactive Claude Code sessions in herdr that
own a piece of work from root cause to production evidence, follows them through hooks, and closes and
learns. CLI `factory`. Status: being planned and built; `docs/program.md` is the current state.

**Start here:** `docs/decisions.md` (what was decided and why) → `docs/program.md` (tracks, who runs them) →
`docs/design.md` (the design) → `docs/research/`.

## Rules

- **Public repo.** No secrets, hostnames, IPs, tailnet names, internal URLs or account e-mails in any tracked
  file. Placeholders: `<your-domain>`, `<see-1password>`. Secrets resolve at runtime through `secrets-run`.
- **The factory never calls a model.** Every judgment (classify, dedup, wording, learnings) is an `agw`
  workflow; the factory calls `agw` like any other client. No model SDK in this repo.
- **Dependencies point one way:** factory → agw, herdr, GitHub, the intake sources. Nothing here is imported
  by agent-workflows.
- **Facts are stored, state is derived.** "Working", "stuck", "waiting" are computed from events when read.
- **Every effect has a deterministic key** (pane names, prompt ids, comment markers), so a replayed tick
  never spawns, prompts or posts twice.
- **Interactive Claude Code in herdr only.** Never headless `claude -p`.
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, the same exit codes,
  never prompts.
- Bun, TypeScript strict, zod at boundaries, exact pins. No Effect: the F0 spike decided that
  (`docs/spikes/2026-10-30-effect/verdict.md`).
- Direct-to-master, conventional commits, no AI attribution. Update this file in the same commit as the
  code it describes.

## Validate

`make check` (format, lint, types, tests) once the skeleton lands in F0. Until then the repo is docs only.
