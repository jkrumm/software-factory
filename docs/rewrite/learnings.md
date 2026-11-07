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
