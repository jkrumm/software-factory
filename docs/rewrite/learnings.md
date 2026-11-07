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
