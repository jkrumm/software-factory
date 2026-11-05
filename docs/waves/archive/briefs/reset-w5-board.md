Branch: reset-w5-board
Title: feat(board): the health line under the asks; the factory heartbeat pushed to Uptime Kuma
Owned files: `config/herdr-app/mods/jk-board/main.js`, `scripts/jk-board-fleet.test.ts`, `scripts/devhost-health-check.sh` (one new push block only), its test if one exists, the docs that describe the board or the devhost pushes (grep `jk-board` and `collie-push-url` in `docs/`, `AGENTS.md`). Never: other mods, `rd`, `wave-gate.py`, hc-reap, the `/wave` skill, anything of software-factory.

# Brief: reset row 6, the dotfiles half — the sidebar's health line and the factory heartbeat

Read `AGENTS.md` first. Context: software-factory (`~/SourceRoot/software-factory`, design `docs/strategy/2026-11-reset/design-v3.md`
§6, decision RS3) now splits what needs attention in two: **asks** (decisions only) and the **health line** (parks, a silent or
over-budget lead, regressions, machine failures; never an ask). Live since software-factory PR #42.

## 1. The board shows the health line under the asks

`config/herdr-app/mods/jk-board/main.js` polls `factory fleet --format json` every 30 s (`:19`), checks `asks` (`parseFleet`,
`:116-120`) and renders ASKS (`asks()` `:431-435`, `askRow()` `:417-429`, the badge `:502-515`, inserted `:539,551`). `/fleet` now
also carries `health: [{ id, kind, text, repo, issue?, session?, since }]`, `kind` one of `park|silent|over_budget|regressions|machine`
(read the live shape: `secrets-run run --env-file=$HOME/SourceRoot/software-factory/.env.tpl -- factory fleet --format json | jq '.health'`).

- `parseFleet` accepts a body without `health` (an older server) as an empty list.
- A HEALTH section under ASKS, dimmer than the asks: one row per line, text, repo, age (from `since`), a click that focuses the
  session's terminal when `session` is set (as `askRow` does). Hidden when empty.
- **The tab badge counts asks only**, never health lines (a health line never asks for the owner).
- Extend `scripts/jk-board-fleet.test.ts`: a body with and without `health`, the badge unchanged by health lines.

## 2. The factory heartbeat to Uptime Kuma

`GET http://127.0.0.1:7793/health` (no token, loopback) now carries `heartbeat: { ok, reason, tickAt, queueMovedAt }`: `ok` is the
factory's own judgment of "the tick advanced and the queue moved within 30 minutes". In `scripts/devhost-health-check.sh` add one push
block after the collie block, in the same pattern (`:1490-1510`): URL file `FACTORY_PUSH_URL_FILE` default
`~/.config/uptime-kuma/factory-push-url`, absent file = silent skip; `curl -s -m 5` the health URL; `heartbeat.ok == true` → `kuma_push up
"tick <tickAt>, queue moved <queueMovedAt>"`; anything else (no answer, 503, no `heartbeat`, `ok` false) → `kuma_push down "<reason or
the curl failure>"`, and the failure joins the script's `failure` like collie's. The homelab monitor (`Software Factory - Push`) and the
URL file are made by a separate brief; do not create the file.

## Validation

Foreground: `node --check` (or the repo's lint for mods) on `main.js`, `bun test scripts/jk-board-fleet.test.ts`, `shellcheck
scripts/devhost-health-check.sh`, and the repo's own quick check for these files if `make check` is heavy (look at the Makefile; do not
run a full `make check` if it takes minutes: the mini is load-bound; say what you ran). Run the new push block once by hand with
`FACTORY_PUSH_URL_FILE` pointing at a temp file holding `http://127.0.0.1:9/none` to see the down path fail cleanly, and without the file
to see the silent skip.

Finish: commit on the branch, push it (`git push -u origin reset-w5-board`), open a ready PR. Report the PR URL, the validation output
verbatim, and a screenshot-free description of the board change. Never touch files outside "Owned files"; if needed, stop and say why.
Never end a turn on a background shell or a wait.
