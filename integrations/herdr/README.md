# Herdr app: jk-glance

The factory at a glance for the Herdr app: short items in the bottom status bar, the detail in a popover on a click, and
nothing to operate. Every popover row is a link into the Console (no button, no control). No ticket words anywhere (no
title, summary or text, tooltips included): an item that waits on the owner shows as its kind, repo and age, a project as
its name and a count. **No list of leads anywhere**: the number of running leads is the figure, by project in a popover.
The words and figures are the Console strip's (`docs/language.md` "Where work stands"): Running, Paused, Ready, Held,
Checking, taken from the overview's `counts.work` (the Console reads the same counts from the flow's `work`; one server
function builds both). The owner reads the rest in the Console.

One mod, three roles, chosen by the block's props (`props()` in the mod):

|Role|Props|What it is|
|-|-|-|
|bar|`{ "bar": true }`|The status-bar segment: the items below. It polls the factory and publishes `shared("jk.factory.glance")`.|
|popover|`{ "kind": "detail", "item": "<key>" }`|The card a click on an item opens (an overlay popup of this same mod). Reads the shared model, never polls.|
|sidebar|none|One line, `Needs you · N · M leads`, `GLANCE_H` px high. Polls too, so keep it out of a layout that has the bar.|

## Layout

**The bar block: at least 608 px wide (`BAR_W`), 28 px high (`BAR_H`, the status row's height).** The widest it can get, with
every figure at its longest, is estimated at 608 px (`barWidth`, held within `BAR_W` by a test). It was 440 before the bar
carried Running, Paused, Ready, Held and Checking in place of Work, Wait and Queue, and 780 while it carried CPU, RAM, Load and the uptime.
The layout (dotfiles, `config/herdr-app/layouts/jk.json`) puts it in the status row of the `work` column as a block beside
`jk-status`, never inside it (a mod cannot add items to another mod's block):

```json
{ "id": "status", "type": "row", "size": { "px": 28 }, "children": [
  { "id": "glance-bar", "type": "block", "size": { "px": 608 }, "content": { "mod": "jk-glance", "props": { "bar": true } } },
  { "id": "status-bar", "type": "block", "content": { "mod": "jk-status" } }
] }
```

**The sidebar block: `GLANCE_H` = 28 px, or gone.** It was 388 px; with the bar carrying everything it should go (remove
the `glance` block from the sidebar column and let the spaces list have the room). Until then it is one line, 28 px, and
shows the same Needs you count and the lead count.

The bar, left to right (a thin separator between groups; each item is one click target; items at 0 are dimmed). Every
popover sits fully above its item, its bottom edge 10 px over the item's top (`placePopup`, held by a test), at least 8 px
from the window's left and top edge:

|Item|Shows|Popover|
|-|-|-|
|**Needs you N**|the overview's `counts.asks + counts.humanQueue`, the `read needs` total standing in when the overview is missing; red above 0|the newest items, `review · shutterflow  4h` (kind, repo, age), each opening that item (`/needs-you?item=<id>`); the title opens `/needs-you`|
|**Running N**, **Paused N**, **Ready N**, **Held N**, **Checking N** (Checking last and quiet)|the overview's `counts.work` (the flow's own `work` when the overview is missing)|**Paused**, **Ready** and **Held** open with one row per split of the word, the largest first, from `counts.work.split` (the contract's `workOf`, whose kind tables the mod copies for the flow fallback): Paused `on you`, `on a timer`, `on another Issue`, `stalled`; Ready by the limit that binds it, `a free seat`, `the host`, `the repo's claims`, `the account's window`; Held `behind another Issue` (opens `/chain`), `the line is red`, `drained`, `an open Spec`, `being settled`. Then one row per project with its count, the busiest first (the card's `work.word`; cut to leave the eight rows their room), opening the Console's `/projects/<name>`. Last row: the change against 7 days ago, coloured as the Flow page does (direction times whether more is better); Ready and Held show the sum of the stored queued and settling samples as `Not started, change in 7 days`. The title opens `/flow?state=<running\|paused\|ready\|held\|checking>`|
|**Ship N**|shipped in the last day: the last of the Flow page's 7 daily bars|three bar charts, all of Issues that closed `done` or `healed`: the last 24 hours and the last 7 days **by the hour**, the last 30 days by the day (`trend.shippedHourly` and `trend.shippedDaily30` of `read flow`; no daily bars for 7 days), then the projects that shipped in the last day with their count, each opening `/projects/<name>`. Title: `/flow`|
|**Prod**, a dot, `N` when red|green, red with the number of red projects, grey while the board's read has not answered (an unknown production is not a green one)|one row per red project, each opening its incident Issue (`/issues/<n>`). A project is red by the server's own rule (`stoppedProjects`, `domains/planning/queue.ts`): an incident Issue queued or working that nothing blocks|
|**Health N**, a dot|only while there are health lines (hidden at 0 and while unknown); amber when every line is of kind `door` (an alert nobody routed), red for any other kind|the lines by kind. The Console has no health page yet, so the title is inert; `HEALTH_PATH` in `main.js` makes it a link once there is one|

**Not here:** CPU, RAM and Load, and Uptime Kuma. They are the mini's chip and the Kuma item of `jk-status` (dotfiles); the bar
publishes the factory's one figure for the chip (`host`, below) and nothing else of the host.

The quota is not drawn: `jk-status` has it. With `FACTORY_CONSOLE_URL` unset the rows are inert and the tooltips say so.
With no good answer for two minutes the bar dims. A popover is as high as its rows (`popupHeight`, at most `MAX_ROWS` = 8
rows, plus the Shipped chart; a longer list ends in `+N more`), 340 px wide. The card measures itself once laid out and, when
its height differs from the guess, places itself again (`fit`), so its bottom edge stays over the item. The window's width
is not known to a mod: the right edge is clamped only where it is known (`placePopup`'s `windowWidth`), which the bar's
items never need, as `jk-status` fills the window to the right of the bar.

## What it calls

Read-only, on the dev host, two calls (only the bar and the sidebar line make them; a popover reads the bar's model):

Every 15 seconds (counts, the open Issues, the load, health and the terminals feed):

- `factory read needs`
- `factory read overview`
- `factory read issues --state all --limit 40`
- `factory read sessions --live`
- `factory read machine`: the load and swap with their ceilings (published as `host`; the bar draws none of it)

Every 60 seconds (the board and the 7-day series, the same read the Console's Flow page draws from):

- `factory read flow`: the `trend` as numbers, what closed in the last day (only its project and outcome, for the Shipped
  project list) and the shipped counts by the hour (7 days) and by the day (30 days) for the Shipped charts, its `work` counts, and which incident Issues stop their project's line. A flow read older than 10 minutes is dropped: the figures stay without trend and
  production goes (Prod turns grey).

Each part parses on its own and keeps its last good answer, so an overview without a needs read (or the other way round)
still draws what it has. All API text is data; the parsers keep numbers, kinds, project names and ids, never a title,
summary, Issue number or phase of a lead (`jk-glance.test.ts` asserts it).

## Credential and Console URL

The call runs `secrets-run run --env-file=.env.tpl -- …` inside the factory checkout on the dev host. `.env.tpl` names
`FACTORY_TOKEN` and `FACTORY_READ_TOKEN`; the CLI takes `FACTORY_TOKEN` when both are set, so the call carries that
token although it only uses read verbs. The token never appears on a command line.

The Console's base URL is `FACTORY_CONSOLE_URL` in `~/.config/factory/env` on the dev host: the clean door, `https://factory.<dev domain>`. Without it the block shows
but does not link, and the tooltips say so.

## Cross-mod contract

What dotfiles renders from this mod (the layout, `config/herdr-app/layouts/jk.json`, and `jk-status`):

1. **The bar block**: `{ "mod": "jk-glance", "props": { "bar": true } }`, at least `BAR_W` (608) px wide and 28 px high, in
   the status row beside `jk-status` (the layout JSON above). `jk-status` keeps the machines (with the load below), the
   quota, the branch, the one Uptime Kuma item and the palette hint, and may drop its own `N needs you` chip (the bar's
   first item). The bar block is 608 px: the layout's `glance-bar` `size.px` follows (it was 780, then 440).
2. **The popovers are this mod**, opened by the bar through `openOverlay({ mod: "jk-glance", kind: "popup", frame: "none",
   width: 340, height, at, props: { kind: "detail", item } })`. Nothing for dotfiles to add: `mod.json` stays
   `{ "place": "none" }`, the same as `jk-details`.
3. **The sidebar block**: remove it (preferred), or keep it at `GLANCE_H` = 28 px. Never both a sidebar block and the bar
   unless the duplicate poll is wanted.

`shared("jk.factory.glance")` is the bar's model, published only when it changed (about every poll while the numbers move;
it is persisted and every mod re-renders on a change, so it holds no history). A mod that wants the figures reads it
instead of polling:

```json
{
  "empty": false,
  "stale": false,
  "items": [{ "group": 0, "key": "needs", "label": "Needs you", "value": "3", "tone": "bad", "dot": null, "dim": false, "tip": "…" }],
  "details": { "ready": { "title": "Ready · 7", "tone": "neutral", "link": "https://factory.<dev domain>/flow?state=ready",
    "rows": [{ "text": "a free seat", "right": "2", "link": "https://factory.<dev domain>/flow?state=ready" }, { "text": "weatherorb", "right": "2", "link": "https://factory.<dev domain>/projects/weatherorb" }], "height": 138 } },
  "host": { "load": 14.8, "loadCeiling": 36, "loadPct": 41, "swapPct": 3, "swapCeiling": 75, "tone": "neutral" },
  "side": { "text": "Needs you · 3 · 4 leads", "tone": "bad", "link": "…", "tip": "…" }
}
```

`items` are in bar order (`group` changes where a separator goes; `key` is one of `needs`, `running`, `paused`, `ready`,
`held`, `checking`, `shipped`, `production`, `health`, the last only while there are health lines); `details` is keyed by the same keys (`health`
is always present); `tone` is `good`, `bad`, `warn`, `dim` or `neutral`; `link` is `null` without a Console URL. A detail
may carry `chart` (the Shipped popover: `[{ caption, right, values }]`) and a row `note`. Before the first good poll it is
`{ "empty": true, "text": "Factory: no data" }`. No Issue title, summary or phase is in it; the one number is a red
project's incident, the link target of its row.

**What `jk-status` may read from it: `host`**, the dev host's load for the mini's chip. `loadPct` is the one-minute load as
a percent of the ceiling above which no new lead is admitted (`null` with no ceiling known; then `load` is the plain
figure), `loadCeiling` that ceiling, `swapPct` and `swapCeiling` the same for swap, `tone` the worse of the two ratios
(`neutral`, amber `warn` from 75 % of a ceiling, red `bad` at or over it). The whole of `host` is `null` until `factory read
machine` has answered. The bar itself draws none of it, and reads no CPU or memory of the host: the chip's own CPU and RAM
are `jk-status`'s.

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

Every field can be `null`. A closed Issue has no entry. `state` is the Issue's stored state (a data key, not a display word), else the session's. `link` is the Issue's place in the Console: its newest Needs you item, else
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
because the mod imports gpui and herdr and cannot load under Bun: the parsers, the row builders (needs, projects, the Paused,
Ready and Held splits, production, health), the one set of figures from the overview and the flow, the strip's words and
order, no retired state word in anything drawn, the Shipped charts, the popover placement and the view model (`glanceModel`, every word the
bar and a popover draw). It holds the placement rule (every popover's bottom edge `POPUP_GAP` px over its item, never
covering it, at each end of the bar and for every height up to the tallest, clamped to the window's edges), the heights and
widths (the sidebar line within 28 px, every popover within `MAX_ROWS` rows and its computed height, the widest bar within
`BAR_W`) and the no-title rule (no title, summary, or number or phase of a lead in any word the mod
draws). `bun test integrations`. `scripts/test/deploy-hook.test.ts` covers the post-deploy hook.

The app check, on a copy, because `herdr-app check` writes a generated `gpui-kit.d.ts` next to the mod:
`cp -R jk-glance /tmp/x/jk-glance && HERDR_APP_HOME=/tmp/home herdr-app check /tmp/x/jk-glance`. It renders once with no
props (the sidebar line) and no data. To exercise the other roles seed the copy: in `init`, set `this.at`, `this.flowAt`,
`this.overview`, `this.needs`, `this.flow`, and `this.machine` (parse real output with the block's own
`parse*` functions) and force `this.role` to `'bar'`; for the popover `'popup'`, `setShared('jk.factory.glance', …)` with
`glanceModel(…)` and `this.props = () => ({ item: 'ready' })`. All three pass on herdr-app 0.1.15 (gpui-shell 0.7.1).
