# Herdr app: jk-glance

A sidebar mod for the Herdr app: the factory at a glance, the essentials of its flow and nothing to operate. Every row is
a link into the Console (no button, no control). No ticket words anywhere (no title, summary or text, tooltips included):
an Issue shows as its number and phase, an item that waits on the owner as its kind, repo and age. The owner reads the
rest in the Console.

## Layout

**268 px wide, 388 px high.** The layout (dotfiles, `config/herdr-app/layouts/jk.json`, block `glance`) must give the
block `size.px: 388` (`GLANCE_H` in `main.js`; it was 144, and 56 before). Every section has a row cap (`MAX_*` in
`main.js`; the headers carry the totals) and the tallest the block can get, 378 px (`WORST_CASE_H`), is held within 388 by
a test.

Top to bottom (every row below is a link; the Console place is in brackets):

- **Needs you · N** (or `Nothing waits on you`; red above 0): the overview's `counts.asks + counts.humanQueue`, the
  `read needs` total standing in when the overview is missing. Click: `/needs-you`. Under it the three newest items,
  `review · shutterflow … 4h` (kind, repo, age), each opening that item (`/needs-you?item=<id>`).
- **Four cells in a 2x2 grid**, the ones the Console's Flow page shows: **Working**, **Waiting**, **Queued**, **Shipped
  this week**. Each has the figure, the change against 7 days ago (arrow and delta) and a 48x16 px sparkline with its last
  point marked (Shipped: 7 daily bars). A state's figure is the overview's count, the change is last minus first sample of
  the trend, Shipped is this week minus the week before, and the colour is the Console's: the direction of the change times
  whether more is better (Working and Shipped yes, Waiting and Queued no; 0 is neutral). Click: `/flow`.
- **Leads · N** (`/flow?state=working`): the working Issues by project, the busiest first, up to four projects. A row is
  the project (`/flow?project=<name>`), its lowest Issue as `#1683 building` (`/issues/<n>`) and `+N` for its other leads
  (the tooltip names them with their phase).
- **Queued · N** (`/flow?state=queued`): why they wait, grouped by the reason that binds each one, the largest group first
  and at most three rows: `7 · production red, only fixes run: weatherorb`, `2 · waits for a free seat`, `3 · 2 other
  reasons`. The reasons are the queue's kinds (`QUEUE_REASONS` in `packages/contract/src/capacity.ts`: `chain`, `line`,
  `finalizing`, `spec`, `unknown_project`, `drain`, `doctor`, `boot`, `load`, `memory`, `lane`, `claim`, `window`, `cap`),
  each in words; an Issue with no reason recorded reads `waits for a free seat`. Chain rows open `/chain`.
- **Production**: a green dot and `Production · green`, or `Production · N red` with one row per red project, each opening
  the incident Issue (`/issues/<n>`). A project is red by the server's own rule (`stoppedProjects`,
  `domains/planning/queue.ts`): an incident Issue queued or working that nothing blocks. Until the board's read has answered
  the dot is grey and says `–`: an unknown production is not a green one.
- **Shipped today · N** (`/flow`): the last of the Flow page's 7 daily bars. Next to it **Load 15/36 · Swap 3%**
  (`/throughput`): the host's one-minute load and swap use against the ceilings above which no new lead is admitted (what
  `factory read machine` answers), grey below 75 % of a ceiling, amber from there, red at it. The ceilings are the pressure
  that matters here; the heavier `read host` (about 250 KB) is not polled.
- **Health · N** with a dot: green at 0, amber when every line is of kind `door` (an alert nobody routed), red for any other
  kind. Next to it `Uptime · up/total up` (red when a monitor is down; the tooltip names them), from the overview's
  `uptime` roll-up (Uptime Kuma through the server's poller; absent when the server has no feed). The Console has no health
  page yet, so the line is inert; `HEALTH_PATH` in `main.js` makes it a link once there is one.

The quota is not drawn: the status bar has it. With `FACTORY_CONSOLE_URL` unset the rows are inert and the tooltip says
so. With no good answer for two minutes the block dims.

## What it calls

Read-only, on the dev host, two calls:

Every 15 seconds (counts, the open Issues, host, health, uptime and the terminals feed):

- `factory read needs`
- `factory read overview`
- `factory read issues --state all --limit 40`
- `factory read sessions --live`
- `factory read machine`

Every 60 seconds (the board and the 7-day series, the same read the Console's Flow page draws from):

- `factory read flow`: the `trend` as numbers, for each queued Issue its queue kind and project, and which incident Issues
  stop their project's line. A flow read older than 10 minutes is dropped: the cells show their figures without trend, the
  queue and production rows go.

Each part parses on its own and keeps its last good answer, so an overview without a needs read (or the other way round)
still draws what it has. All API text is data; the parsers keep numbers, kinds, project names, phases and ids, never a
title or summary (`jk-glance.test.ts` asserts it).

## Credential and Console URL

The call runs `secrets-run run --env-file=.env.tpl -- …` inside the factory checkout on the dev host. `.env.tpl` names
`FACTORY_TOKEN` and `FACTORY_READ_TOKEN`; the CLI takes `FACTORY_TOKEN` when both are set, so the call carries that
token although it only uses read verbs. The token never appears on a command line.

The Console's base URL is `FACTORY_CONSOLE_URL` in `~/.config/factory/env` on the dev host: the clean door, `https://factory.<dev domain>`. Without it the block shows
but does not link, and the tooltips say so.

## Cross-mod contract

The same poll publishes `shared("jk.factory.terminals")` when its content changed. The `jk-pane` and `jk-tabs` mods (they
stay in dotfiles, `config/herdr-app/mods`) read it to draw each terminal's header and the Console link on its tab. The
value is an object keyed by app terminal address, `mini/<terminal id>`, one entry per live session that has a terminal:

```json
{
  "mini/t1a": {
    "title": "the Issue's title",
    "summary": "one sentence",
    "state": "working",
    "repo": "repo-name",
    "link": "https://factory.<dev domain>/needs-you?item=<id>"
  }
}
```

Every field can be `null`. A closed Issue has no entry. `state` is the Issue's state in the language's words (`settling`, `queued`, `working`,
`waiting`, `watching`), else the session's. `link` is the Issue's place in the Console: its newest Needs you item, else
its page (`/issues/<n>`), and `null` for a session without an Issue or without a Console URL. No
Issue number, role or phase is shared, and none is shown there: the screen says what the work is about. Only these fields are
shared: no insights, no elapsed time, because the value is persisted and every mod re-renders when it changes.

A lead's tab goes with its terminal: when the Issue's lead ends, the factory removes the terminal and the app drops the
tab.

## Install and keeping it current

The Herdr app runs on the owner's laptop, a thin client with no factory checkout; the mod's source is here. What the app
loads is `~/.config/herdr-app/mods/jk-glance` there, a link to a copy of this directory that the laptop pulls from the
**deployed release** on the dev host (`~/.software-factory/current/integrations/herdr/jk-glance`), so the mod the app runs
is the one of the commit that is live. `mod.json` has `{ "place": "none" }`: the mod is a view, not a pane of its own.

dotfiles owns the laptop side (`scripts/herdr-glance-sync.sh`, the `herdr-glance-sync` verb of the laptop's forced-command
gate, `make herdr-app-setup`). The factory's part is one seam, the post-deploy hook of `scripts/deploy.sh`: after a deploy
whose server is healthy it starts the executable at `~/.config/factory/post-deploy` (override: `FACTORY_POST_DEPLOY_HOOK`)
in the background with the release dir and the sha, output in `~/Library/Logs/factory-post-deploy.log`, never delaying or
failing the deploy. On the dev host that file is dotfiles' link to the script that asks the laptop to sync; without it
nothing happens. So the mod on the laptop follows `master` as each deploy lands, and the version check is the same on
both sides: `shasum -a 256 main.js mod.json` of this directory against the copy the app loads.

The old `jk-board` mod is gone from this repo and from dotfiles; `make herdr-app-setup` removes a stale `jk-board` link.

## Test

`jk-glance.test.ts` runs the pure-helper block of `main.js` (between `// <glance>` and `// </glance>`) on its own,
because the mod imports gpui and herdr and cannot load under Bun: the parsers, the sparkline and bar geometry, the section
builders (needs rows, leads, queue reasons, production, host) and the view model (`glanceModel`, every word the block
draws). `bun test integrations`. `scripts/test/deploy-hook.test.ts` covers the post-deploy hook.

The app check, on a copy, because `herdr-app check` writes a generated `gpui-kit.d.ts` next to the mod:
`cp -R jk-glance /tmp/x/jk-glance && HERDR_APP_HOME=/tmp/home herdr-app check /tmp/x/jk-glance`. It renders once, and the
mod starts with no data, so seed `this.at`, `this.flowAt`, `this.overview`, `this.needs`, `this.flow` and `this.machine`
in the copy (parse real `factory read` output with the block's own `parse*` functions) to exercise the drawing. Passes on
herdr-app 0.1.15 (gpui-shell 0.7.1).
