Branch: spike/effect
Title: spike: fleet slice in Effect 4
Owned files: everything on this branch except `docs/` and `.claude/`
Task: Build the slice in `docs/spikes/2026-10-30-effect/spec.md`, all of it, in Effect 4. Read that file first; it is the whole spec. Then load the `effect` skill (`.claude/skills/effect/SKILL.md`) and follow it: its pins, its house rules, its determinism rule. Stack: Bun 1.4.3, TypeScript 7.0.2 strict with `@effect/tsgo`, `@effect/sql-pg`, `@effect/platform-bun`, `@effect/vitest`. Use Effect's own HTTP server modules or `Bun.serve` at the edge, whichever `ai-docs` shows clearest. `TestClock` so no test waits real time. If an exact pin is refused by the 3-day release-age cooldown, take the newest version that clears it; never lower the cooldown or add an exclude. This branch is a measurement and is not merged. Do not read any other branch.
Validation: `bunx tsc --noEmit && bunx vitest run`, both green, all six test groups of the spec present.
Finish: commit, push the branch (`git push -u origin spike/effect`). Do not open a PR. Report the validation output verbatim.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
