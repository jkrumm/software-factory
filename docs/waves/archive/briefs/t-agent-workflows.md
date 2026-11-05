Branch: t-oxc
Title: build: oxfmt replaces Biome, oxlint takes over its rules
Owned files: `biome.json` (root only), `.oxlintrc.json`, `.oxfmtrc.json`, `Makefile`, `package.json` (root and packages), `bun.lock`, `AGENTS.md`, `docs/concept.md`, `agents/check/AGENTS.md`, Biome-named comments or suppressions in `packages/**` (`rg -il biome packages`), and any source file oxfmt reformats (formatting commit only). Never: `docs/spikes/**` (`docs/spikes/s3-stack` keeps its own `biome.json`), `docs/evidence/**`, `docs/waves/archive/**`.
Task:
Track T in `~/SourceRoot/software-factory/docs/program.md` (owner decision 2026-10-30: no Biome). Read that section and `AGENTS.md` first.
1. Remove the root `biome.json`, `@biomejs/biome`, and every Biome call: `Makefile` (the comment near the top, the `check` steps, the format target), `package.json` scripts, `AGENTS.md`, `docs/concept.md`, `agents/check/AGENTS.md`, and Biome-named source comments or suppressions (`rg -il biome packages`; a `biome-ignore` becomes the oxlint equivalent or goes if the rule no longer applies).
2. Keep the existing `oxlint -c .oxlintrc.json --type-aware packages` step and extend `.oxlintrc.json` to the rules Biome was enforcing (read `biome.json` before deleting it and map each enabled rule or group; list what has no oxlint equivalent in the PR body). Use `~/SourceRoot/argo/.oxlintrc.json` as a reference.
3. Add oxfmt, an exact pin that clears the 3-day release-age cooldown in `~/.bunfig.toml` (never an exclude). Start from `~/SourceRoot/argo/.oxfmtrc.json`, with options set to match the current Biome formatting (quote style, semicolons, line width, indent, trailing commas, arrow parens, from `biome.json` and the code as it is), so the reformat diff is as small as possible. Report its size.
4. `bun test` and `tsc` stay; no Vite+.
5. Commits: first the tool swap, then **one separate commit** with only the oxfmt reformat (`style: oxfmt`), then any lint fixes the new rules demand.
6. After merge the orchestrator deploys; you only need `make check` green on the branch. Do not run `make deploy`.
Acceptance: `make check` green; `rg -il biome` returns only `docs/spikes/**`, `docs/evidence/**`, `docs/waves/archive/**` paths; CI green.
Validation: `make check` (foreground; never two `make check` at once on this host: load timeouts).
Finish: push `t-oxc`, open a ready PR, wait for CI in the foreground with `timeout`. Report the PR URL, the `make check` output verbatim, the rule mapping and the format diff size. Do not merge.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
