Branch: f1-seed-space
Title: fix(runner): a new space is seeded in the app's document with the main checkout's name and folder
Owned files: `packages/server/src/hc-runner.ts`, `packages/server/src/app-doc.ts`, `packages/server/test/**`, `AGENTS.md` (the FL6 paragraph). Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`.

# Brief: seed a new space's entry in the app's document

Owner-reported, live (2026-11-01). Read `AGENTS.md` first (FL6 "One space per repo", "The runner looks before it acts").

**Bug.** A spawn into a repo with no space on the mini gets a space nobody names. Case: `shutterflow-fleet-hc-only`, a fan
worker in `~/SourceRoot/shutterflow/.claude/worktrees/w9-fleet-hc-only`. The mini's `herdr-app` document had no shutterflow
space, so `HcRunner.spaceId` (`hc-runner.ts:327-338`) fell back to `defaultSpaceId(root)` = `sp-shutterflow-<hash>`. The app
then adopted that label with `name: ""` and `folder` = the first terminal's cwd (the worktree), and the sidebar shows a space
called `w9-fleet-hc-only`. The next spawn into shutterflow's main checkout would not find that entry by folder either.

**Fix.** When `spaceId` returns an id that has no entry in the document (the hashed fallback, and the `new_space` id from
`ownSpaceId`), seed the entry before the terminal is run: `doc.get`, append `{ id, name: basename(root), folder: root, tabs: [] }`
to `spaces`, `doc.set` with compare-and-set on `version`, a conflict reads again (the `nameTab` pattern in `app-doc.ts:57`).
`root` is the space's resolved path, the main checkout for a worktree, never the worktree. Never touch an existing entry. A
`new_space` second space gets a name that tells it apart (e.g. `<basename> 2`, your call, documented). Seeding is best effort
like `nameTab`: a failure logs nothing fatal and the start goes on; the id stays the hashed one, so a later seed or the app
still lands on the same space.

**Check the shape against the live document first** (read only: `hc` against the owner's core, `doc.get herdr-app`; never
`doc.set` there): space entries carry `id, name, folder, tabs[]` and tabs `id, name, root`. If the app needs more fields for an
entry it did not create, find out in a scratch core (`HC_SESSION`, scratch `XDG_*`, see dotfiles `docs/herdr-core.md`
§Ground rules) with the fake app absent, and say so in the report: the app itself runs on the MacBook, so its adoption rules
can only be inferred from the document.

**Tests** with the hc fake (`packages/server/test/support/fake-hc.ts`): a spawn into a repo with no space seeds one entry with
the main checkout's basename and folder (a worktree spawn included); an existing entry is found by folder and left alone; a CAS
conflict retries; a failing `doc.set` does not fail the start; two spawns into the same new repo seed it once.

Also look at `rd`'s own direct-to-hc path (`dotfiles/scripts/remote-dev.sh` around the doc writes, ~line 286): if it has the
same gap, say so in the report; don't change dotfiles.

**Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every
review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads
your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or
deploy. End with a report: done / deferred, one line each.
