Branch: reset-w6-spaces
Title: feat(spaces): the fixed spaces — one space per listed repo with a plan tab that is never closed
Owned files: `packages/server/src/spaces.ts` (new: the reconcile), `packages/server/src/hc-runner.ts` (only what the reconcile needs: a start of a `plan:` shell through the same `serialized` lock, a guard), `packages/server/src/app-doc.ts` (only if `seedSpace` needs a small export), `packages/server/src/main.ts` and `packages/server/src/tick.ts` (wiring a `kick()` only), `packages/server/src/config.ts` (one path setting), `packages/server/src/issues/finalize.ts` (a guard only), `packages/server/test/**` (incl. `support/fake-hc.ts`), `packages/server/test/hc-e2e.test.ts` (only to add a case), `docs/design.md` (§3 "As built", §8 if it is mirrored there), `AGENTS.md` (the Placement line, the Layout's server list). Never: dotfiles (a separate brief writes `spaces.json`), `docs/waves/**`, `docs/program.md`, `docs/strategy/**`, migrations.

# Brief: reset row 11 — spaces are fixed and ready

Read `AGENTS.md` first (Placement and sessions, Trust boundary, deterministic keys), then `docs/strategy/2026-11-reset/design-v3.md`
§8 and decision RS6 in `docs/decisions.md`.

## Decided by the program lead (do not re-litigate)

- **Order is not the factory's.** dotfiles `config/herdr-app/groups.json` already orders the sidebar (the `jk-spaces` mod files each
  space under its group, in that order). The factory never reorders the app doc (`herdr-core.md` warns a structural `doc.set` is the
  fragile path). It only makes sure every listed space exists and has its `plan:` tab.
- **Input:** `~/.config/factory/spaces.json` (path setting `FACTORY_SPACES_FILE`, default under `$HOME` as `config.ts` builds the others),
  `{ "spaces": [{ "name": "<repo>", "path": "<absolute path>" }] }`, written by dotfiles `make setup` (not yours). Absent or invalid file:
  log once, do nothing (zod at the boundary).
- **Trust boundary:** an entry whose `realpath` is not inside `FACTORY_REPO_ROOTS` is skipped (IuRoot repos are not ours to place a
  shell into); so is a path that does not exist.

## The reconcile (`spaces.ts`)

On start and every 10 minutes (a `kick()` from the tick with its own interval, the `FleetBuilder.kick` pattern: never throws, never two
at once, never on the tick's own time or in a transaction). Per entry, in file order:

1. The space: found by real path as `HcRunner.spaceId` finds it today (the app doc entry whose folder matches); none → `seedSpace` (it
   appends; fine).
2. The `plan:` tab: a live terminal labelled `factory.key=plan:<name>` exists → nothing. None → start one through `HcRunner`'s
   `serialized` start path: no argv (the machine's own shell; check it is a login shell on a scratch core and say what you found),
   `cwd` the repo, `keep: true`, `no_parent: true`, labels `factory.key=plan:<name>`, `herdr.space=<the space id>`, `herdr.tab=<a
   deterministic tab id for plan:<name>>`, `factory.tab_name=plan`. It must be the space's **first** tab: if the app doc lets you place it
   (tabs order in the doc entry), put it first on creation only; never move tabs that exist.
3. A second run with nothing changed starts nothing and writes nothing (prove it in a test: the fake's call log).

**Never close a `plan:` tab:** guard `HcRunner.close` (and anything else that kills or removes by key) so a key starting `plan:` is
refused, and `finalize` (it closes only exact lead and worker keys today; keep it so and add a test that a `plan:` key is never
passed). A `plan:` key is not a spawn: no `spawns` row, no session state, no hook (the shell runs no Claude Code until the owner starts
one; if the owner does, that session is the owner's).

**Unknown repos appended on first use** is today's behaviour of `spaceId`/`seedSpace` for a spawn whose repo is not listed; keep it and
say so in design.md.

## Tests

The fake (`support/fake-hc.ts`) needs what the reconcile calls (it has `terminal.run|list|kill|rm`, labels, `doc.get|set`; add
`terminal.label` only if you use it). Tests: an entry gets its space and plan tab; a second reconcile changes nothing; an entry outside
the roots and a missing path are skipped; a dead plan terminal is started again (by key, deterministic); `close('plan:x')` is refused.
If `HC_E2E=1` can run, add one case against a scratch core and report it (the label semantics of an unknown `herdr.space` id differ
between `docs/herdr-core.md` and the herdr skill: verify which is true and say so).

## Validation

Foreground, one at a time: `bunx tsc --noEmit -p .`, `bunx oxfmt --check .`, `bunx oxlint -c .oxlintrc.json --type-aware packages`, and
`bun test` on each test file you touched. **Do not run `make check`.** Finish: commit, push `reset-w6-spaces`, open a ready PR. Report
the PR URL, validation output verbatim, the login-shell and label findings, and what you left out. Never touch files outside "Owned
files": stop and say which and why. Never end a turn on a background shell or a wait.
