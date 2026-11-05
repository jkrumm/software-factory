Branch: f1-w6-retire-hermes
Title: feat: the Hermes babysitter crons retire, the software factory babysits
Owned files: `scripts/quota-nudge.py` and its tests, `docs/scheduled-jobs.md`, `README.md`, `AGENTS.md`, `config.yaml` (only a quota-nudge or babysitter entry, if one exists), plus the live Hermes cron registry (`cron/jobs.json` is runtime state, not tracked: change it through Hermes' own cron command, never by editing the file). Never anything else.
Task:
F1 Wave 6's retirement (FL8 in `~/SourceRoot/software-factory/docs/decisions.md`): the software factory's resume watchdog and rules now babysit every session `rd` and the factory start (`software-factory/AGENTS.md`, the rules list), so the Hermes babysitter crons go.

1. The cron jobs `quota-nudge` (id `b7a45b694f80`, every 30 min, `scripts/quota-nudge.py`, enabled) and `Fleet babysitter` (id `9919cec4a6d5`, disabled): remove both from the live registry with Hermes' cron command; show the registry before and after in the PR body.
2. Delete `scripts/quota-nudge.py` and whatever only it uses (its state and log under `~/.hermes/cache/quota-nudge*` may be deleted too; say so). Keep anything another job still calls (`rg` first).
3. Docs: `docs/scheduled-jobs.md` and every mention in `README.md`/`AGENTS.md` say the factory babysits now (one line, pointing at `software-factory`), nothing about the retired jobs beyond that. `scripts/check-cron-registry.py` should pass for these two jobs afterwards; its other pre-existing mismatches (claude-release-watch, the Morning briefing / Evening report state) are not yours, list them in the PR body.
Validation: the repo's own check (`make check` or what `AGENTS.md` names, foreground), and `scripts/check-cron-registry.py`.
Finish: commit, push `f1-w6-retire-hermes`, open a ready PR, `/review` and fix its blocking findings, then one more pass on the fix commits, CI in the foreground with `timeout` if the repo has CI. No background shell left running. Report the PR URL. Do not merge.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
