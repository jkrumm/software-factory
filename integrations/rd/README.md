# rd

`rd` is the owner's remote-dev command. It lives in dotfiles (`scripts/remote-dev.sh`) and stays there; this is the
contract it keeps with the factory. The factory side of each verb is generated from the OpenAPI document
(`role` is hand-written).

**`rd` is not a second factory CLI.** On the host `factory` authenticates itself (no `FACTORY_TOKEN` and no
`FACTORY_READ_TOKEN`: it resolves the owner token from the deployed release's `.env.tpl` through `secrets-run`; a set
token, a lead's or the orchestrator's, always wins), so `factory issue new`, `factory issue list` and
`factory signal file --from agent:<repo>` are the way to file and list. `rd` keeps only the owner's terminal verbs
(`work`, `agents`, `read`, `say`, `reap`); its `issue`, `issues` and `signal` verbs are to become passthroughs to the
factory, then retire. The wrapper below is what `rd` still does for `health`, `role get` and `session note` until it
calls the bare CLI too.

## How every call runs

On the dev host, never on the laptop:

```sh
timeout <secs> secrets-run run --env-file=<deployed release>/.env.tpl -- factory <args>
```

The release is `~/.software-factory/current`. The token is resolved by `secrets-run` from `.env.tpl` and never reaches a
command line. Every call is bounded: 3 seconds for `health`, 15 for `issue new`, `issue list` and `session note`. The
host's `timeout` or `gtimeout` is required; without one there is no factory path (exit 126), because an unbounded call
could hang on a factory that is down. `RD_TIMEOUT_CMDS` overrides the binary names.

`role get` is the exception: the script runs `factory role get` directly on the host, not wrapped in `secrets-run`,
bounded to 2 seconds by `timeout` or `gtimeout` (unbounded when the host has neither).

## Verbs

| Verb | Used by | When the factory fails |
|-|-|-|
| `health` | `rd say`, once per command | fails open: the factory counts as down and `say` sends through `hc` |
| `role get <role> --format json` | a spawn with `--role` | fails open: one stderr line, the spawn keeps its default model and effort |
| `issue new` | `rd issue` | fails closed: no Issue, the factory's exit code is `rd`'s own |
| `issue list` | `rd issues` | fails closed: the factory's exit code is `rd`'s own |
| `session note <key> <text>` | `rd say` to a named agent | fails closed unless the factory says the session does not exist |

`role get` must print exactly `{"role","tier","effort"}` with a tier of `haiku|sonnet|opus`; anything else fails open.
An answer of `not_found` (or a role name that is not `[A-Za-z][A-Za-z0-9_-]*`) is a usage error, exit 2, and nothing
starts.

For `session note`, only a structured `not_found` answer falls back to `hc send`. Any other failure may have recorded
the note, so `rd` reports it and does not send the text a second time. A failed `issue new` is never retried through
`hc`.

`rd issue` forwards the factory's stderr and exit code verbatim, so a hint the factory prints reaches the `rd` user. The
`--facts` shape is `factory issue schema`. `rd issue` has no `--text`; it forwards `--facts`, `--after` and `--key`.

## Exit codes

`factory` exits with the table in `apps/cli/src/exit.ts` (0 ok, 2 usage, 3 auth, 4 not found, 5 conflict, 7 network,
and so on), and `rd issue` and `rd issues` pass it through. The wrapper adds three:

- 124: the call timed out.
- 126: the host has no `timeout` binary.
- 127: `factory` is not installed on the host.

## Switches

- `RD_NO_FACTORY=1`: skip the `health` probe, so `rd say` goes straight to `hc`. The escape hatch for a factory that
  answers but misbehaves. `issue`, `issues` and `--role` do not check it.
- `RD_TIMEOUT_CMDS`: names of the timeout binary to try.
- `RD_MODEL`, `RD_EFFORT`: win over the role table, which is then skipped when both decide everything.
