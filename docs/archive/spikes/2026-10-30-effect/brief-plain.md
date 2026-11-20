Branch: spike/plain
Title: spike: fleet slice in plain TypeScript and zod
Owned files: everything on this branch except `docs/` and `.claude/`
Task: Build the slice in `docs/spikes/2026-10-30-effect/spec.md`, all of it, in plain TypeScript. Read that file first; it is the whole spec. Stack: Bun 1.4.3, TypeScript 7.0.2 strict, zod at boundaries, `Bun.serve`, Bun's built-in SQL client for Postgres, `bun test`. Exact pins. Hand-written retry and tick code, no framework. Inject the clock so no test waits real time. If an exact pin is refused by the 3-day release-age cooldown, take the newest version that clears it; never lower the cooldown or add an exclude. This branch is a measurement and is not merged. Do not read any other branch.
Validation: `bunx tsc --noEmit && bun test`, both green, all six test groups of the spec present.
Finish: commit, push the branch (`git push -u origin spike/plain`). Do not open a PR. Report the validation output verbatim.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
