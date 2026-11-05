Branch: night-c0-cleanup
Title: refactor: drop the one-release compatibility, add the deep role, cut AGENTS.md to rules and pointers
Owned files: `packages/**`, `config/roles.json`, `AGENTS.md`, `docs/design.md`, a new migration. Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, `docs/waves/night-2026-11-01.md`.

# Brief: C0, the night's cleanup before F2

Read `AGENTS.md` and `docs/waves/night-2026-11-01.md` (decision 6) first. The owner decided (2026-11-01): one user and a drained
queue make a rollback a decision, not a constraint, so the "for one release" compatibility goes. Expand/contract stays for
migrations only. One commit per concern, in this order.

## 1. Drop the compatibility (one commit, plus its migration)

- The vocabulary aliases of migration 010: the `herdr_status`/`herdr_seen_at` columns (stop writing, then a migration `011_*`
  drops them), the `herdr_restarted` kind and the `_herdr` pseudo-session (stop accepting them in the socket, the spool and the
  rules; keep reading old *stored* rows only if a derivation would break without, and say so), `Session.herdrStatus|herdrSeenAt`
  in the contract and the server.
  **Before removing a contract field, grep its consumers:** `~/SourceRoot/argo`, `~/SourceRoot/agent-workflows/packages`,
  `~/SourceRoot/dotfiles/scripts` and `config`, `~/SourceRoot/iris` for `herdrStatus|herdrSeenAt` read *from the factory's API*
  (agw has its own `herdrStatus` field in its fleet model; that one is not ours). If a consumer reads ours, keep that field,
  report it, and don't change the other repo.
- `capacity_readings`: stop feeding it; the same migration drops the table.
- Every "the previous release …, drain before rolling back", "an older CLI/rd …", "for one release", "drop it, and this
  sentence, in the release after" in `AGENTS.md` and `docs/design.md`: delete, together with the code they describe.
- Classic-herdr leftovers in the hook and the session record (`HERDR_PANE_ID`, `HERDR_TAB_ID`, classic pane parsing): drop
  where only classic herdr produced them. Keep the derivation that a pane which is no terminal of the current core is gone
  (that is what reads the 113 old spawns as `ended`).

## 2. The role `deep` (one commit)

`config/roles.json` gains `"deep": { "tier": "opus", "effort": "high" }`. It is placed like a worker: `isWorker`
(`packages/server/src/hc-runner.ts:86`) includes it, so a `deep` spawn with a parent terminal is that terminal's hidden child.
A test pins the placement. AGENTS.md's role line names it: a worker raised for novel hard logic. `rd fan --role deep` resolves
through `factory role get deep`; check that nothing in `dotfiles/scripts/remote-dev.sh` rejects the name (read only; report).

## 3. AGENTS.md to rules and pointers (one `docs:` commit)

Today about 38k characters; the target is ≤ 15k. AGENTS.md keeps: what the repo is, the start-here line, every rule an agent
must not break (one or two lines each: public repo, no model call, dependencies one way, facts stored, deterministic keys,
interactive Claude only, CLI contract, the toolchain, never a port inside a transaction, the trust boundary, hooks stay
stdout-silent and import only `node:fs` + the spool, one process, one contract, one schema, migrations expand/contract, the
API's auth), the layout, Validate. Every behaviour paragraph (the runner, the space rules, prompt delivery, the rules that act,
the witness, the spool, admission, quota, slots, status) **moves** to `docs/design.md` §3 as "as built", with a pointer line
left in AGENTS.md. Move, never lose: after the commit, every fact of the old AGENTS.md is in one of the two files (check it
with a diff of sentences, and say in the report what you merged with an existing design paragraph because both said the same).
Where design.md and the old AGENTS.md disagree, the code decides; name each case.

**Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every
review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads
your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or
deploy. End with a report: done / deferred, one line each, plus any consumer you found in step 1.
