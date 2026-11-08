# Herdr app: jk-glance

A sidebar mod for the Herdr app. Two rows of text show the factory at a glance:

- `Needs you · N` (or `Nothing waits on you`): the open Decisions, artifacts awaiting a verdict, Errands and held
  signals. The tooltip carries the newest item's title.
- `Running · W working · Q queued · N waiting`: the counts from the overview.

A click opens the Console in the default browser: the first row at `/needs-you` (the newest item selected), the second
at `/flow`. With no good answer for two minutes the block dims.

## What it calls

One call on the dev host every 15 seconds, read-only:

- `factory read needs`
- `factory read overview`
- `factory read issues --state all --limit 40`
- `factory read sessions --live`

Each part parses on its own and keeps its last good answer.

## Credential and Console URL

The call runs `secrets-run run --env-file=.env.tpl -- …` inside the factory checkout on the dev host. `.env.tpl` names
`FACTORY_TOKEN` and `FACTORY_READ_TOKEN`; the CLI takes `FACTORY_TOKEN` when both are set, so the call carries that
token although it only uses read verbs. The token never appears on a command line.

The Console's base URL is `FACTORY_CONSOLE_URL` in `~/.config/factory/env` on the dev host: the clean door, `https://factory.<dev domain>`. Without it the rows show
but do not link, and the tooltip says so.

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

Every field can be `null`. `state` is the Issue's state in the language's words (`settling`, `queued`, `working`,
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
because the mod imports gpui and herdr and cannot load under Bun. `bun test integrations`.
