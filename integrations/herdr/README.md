# Herdr app: jk-glance

A sidebar mod for the Herdr app: the factory as an aggregate, at a glance. No ticket anywhere (no title, summary or id,
tooltips included): the owner reads Issues in the Console.

## Layout

**268 px wide, 144 px high.** The layout (dotfiles, `config/herdr-app/layouts/jk.json`, block `glance`) must give the
block `size.px: 144` (it was 56).

Top to bottom:

- `Needs you · N` (or `Nothing waits on you`): the overview's `counts.asks + counts.humanQueue`, red while above 0. The
  `read needs` total stands in when the overview is missing. Click: Console `/needs-you`.
- Four cells in a 2x2 grid, the ones the Console's Flow page shows: **Working**, **Waiting**, **Queued**, **Shipped this
  week**. Each has the figure, the change against 7 days ago (arrow and delta) and a 48x16 px sparkline with its last point
  marked (Shipped: 7 daily bars). The figure of a state is the overview's count, the change is last minus first sample of
  the trend, Shipped is this week minus the week before, and the colour is the Console's: the direction of the change
  times whether more is better (Working and Shipped yes, Waiting and Queued no; 0 is neutral). Click: Console `/flow`.
- `Health · N` with a dot: green at 0, amber when every line is of kind `door` (an alert nobody routed), red for any other
  kind. Next to it `Uptime · up/total up` (red when a monitor is down; the tooltip names them), from the overview's
  `uptime` roll-up (Uptime Kuma through the server's poller; absent when the server has no feed). The Console has no health
  page yet, so the line is inert; `HEALTH_PATH` in `main.js` makes it a link once there is one.

The quota is not drawn: the status bar has it. With `FACTORY_CONSOLE_URL` unset the cells are inert and the tooltip says so.
With no good answer for two minutes the block dims.

## What it calls

Read-only, on the dev host, two calls:

Every 15 seconds (counts, health, uptime and the terminals feed):

- `factory read needs`
- `factory read overview`
- `factory read issues --state all --limit 40`
- `factory read sessions --live`

Every 60 seconds (the 7-day series, the same read the Console's Flow page draws its trends from):

- `factory read flow`: only `trend` is kept, as numbers. A trend older than 10 minutes is dropped and the cells show their
  figures without trend.

Each part parses on its own and keeps its last good answer, so an overview without a needs read (or the other way round)
still draws what it has. All API text is data.

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
the flow (the Console has no Issue page yet), and `null` for a session without an Issue or without a Console URL. No
Issue number, role or phase is shared, and none is shown: the screen says what the work is about. Only these fields are
shared: no insights, no elapsed time, because the value is persisted and every mod re-renders when it changes.

A lead's tab goes with its terminal: when the Issue's lead ends, the factory removes the terminal and the app drops the
tab.

## Install

1. Link or copy `jk-glance/` into the Herdr app's mods directory: `~/.config/herdr-app/mods/jk-glance`.
2. Add the mod to the app's layout (the sidebar), then reload the app.

dotfiles `make herdr-app-setup` does both. `mod.json` has `{ "place": "none" }`: the mod is a view, not a pane of its
own.

## Test

`jk-glance.test.ts` runs the pure-helper block of `main.js` (between `// <glance>` and `// </glance>`) on its own,
because the mod imports gpui and herdr and cannot load under Bun: the parsers, the sparkline and bar geometry, and the
view model (`glanceModel`, every word the block draws). `bun test integrations`.

The app check, on a copy, because `herdr-app check` writes a generated `gpui-kit.d.ts` next to the mod:
`cp -R jk-glance /tmp/x/jk-glance && HERDR_APP_HOME=/tmp/home herdr-app check /tmp/x/jk-glance`. It renders once, and the
mod starts with no data, so seed `this.at`, `this.overview`, `this.needs` and `this.flow` in the copy to exercise the
drawing. Passes on herdr-app 0.1.15 (gpui-shell 0.7.1).
