# Claude Code hooks

`hooks.json` is the source of the six factory hook entries. A factory session reports its life through them; the server
derives the lead's state from the events.

| Event | Command | What it reports |
|-|-|-|
| `SessionStart` | `factory hook session-start` | the session began (or resumed, or compacted) |
| `UserPromptSubmit` | `factory hook user-prompt-submit` | a prompt arrived |
| `Stop` | `factory hook stop` | the turn ended; the one hook that can answer |
| `StopFailure` (matcher `rate_limit`) | `factory hook stop-failure` | the account hit a limit |
| `Notification` (permission, idle and quota prompts) | `factory hook notification` | the session waits for someone |
| `SessionEnd` | `factory hook session-end` | the session ended |

## Behaviour

Every command starts with `[ -n "$FACTORY_SESSION" ]`: outside a factory session the hook does nothing, and so does it
when `factory` is not installed. Inside one, `factory hook <event>` appends the fact to the spool first, then posts it
to the server over a unix socket (300 ms, best effort), and exits 0 whatever happens. The one exception is the `Stop`
send-back: when the server holds a note for the session, the hook exits 2 and Claude Code keeps the session going. The
hook prints nothing on stdout, because Claude Code injects a hook's stdout into the session. See `apps/cli/src/hook.ts`.

## Credential

None in the hook line. The hook socket (mode 0600) is the credential: a same-user boundary, not a per-session one.

## Merge

`hooks.json` holds `{ "hooks": { "<Event>": [ … ] } }`. Each event's entries are appended to the same event in a
settings file as their own array elements, other hooks stay. Running it twice does not duplicate the entries.

```sh
jq --slurpfile f hooks.json '.hooks = reduce ($f[0].hooks | keys[]) as $e ((.hooks // {}); .[$e] = (((.[$e] // []) - $f[0].hooks[$e]) + $f[0].hooks[$e]))' settings.json > settings.merged.json
```

Check the result, then replace `settings.json`.

## Test

`scripts/test/integrations-hooks.test.ts` checks that the file is valid JSON, covers exactly these six events, and that
every command is guarded by `$FACTORY_SESSION`.
