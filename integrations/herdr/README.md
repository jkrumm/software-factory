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

The Console's base URL is `FACTORY_CONSOLE_URL` in `~/.config/factory/env` on the dev host. Without it the rows show
but do not link, and the tooltip says so.

## Cross-mod contract

The same poll publishes `shared("jk.factory.terminals")` when its content changed. The `jk-pane` mod (it stays in
dotfiles, `config/herdr-app/mods/jk-pane`) reads it to draw each terminal's header. The value is an object keyed by app
terminal address, `mini/<terminal id>`, one entry per live session that has a terminal:

```json
{
  "mini/t1a": {
    "issue": 362,
    "title": "filed title",
    "short": "short title",
    "summary": "one sentence",
    "phase": "…",
    "role": "lead",
    "state": "working",
    "repo": "repo-name"
  }
}
```

Every field can be `null`. `issue` is the Issue id (or `null` for a session without one). `title` is the Issue's filed
title, `short` its working title, `summary` and `phase` come from the Issue, `role` and `state` from the session, `repo`
from the Issue or the session's working folder. Only these fields are shared: no insights, no elapsed time, because the
value is persisted and every mod re-renders when it changes.

## Install

1. Link or copy `jk-glance/` into the Herdr app's mods directory: `~/.config/herdr-app/mods/jk-glance`.
2. Add the mod to the app's layout (the sidebar), then reload the app.

dotfiles `make herdr-app-setup` does both. `mod.json` has `{ "place": "none" }`: the mod is a view, not a pane of its
own.

## Test

`jk-glance.test.ts` runs the pure-helper block of `main.js` (between `// <glance>` and `// </glance>`) on its own,
because the mod imports gpui and herdr and cannot load under Bun. `bun test integrations`.
