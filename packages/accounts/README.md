# @software-factory/accounts

The picker for N Claude Code subscriptions: a registry of accounts, a per-account quota cache, the rule that says which account a new
session starts on, and the `claude-account` CLI around them. It needs bun, the `claude` binary and macOS (the logins live in the Keychain). It does not need the
factory server, a database or a second machine. The design, the rule and every file location are in [`docs/accounts.md`](../../docs/accounts.md).

## From nothing to a first pick with two accounts

You have two Claude subscriptions, say a Max and an Ultra, and `claude-account` on your PATH (`bun packages/accounts/bin/claude-account.ts` from a checkout, or the
single file `make accounts-bundle` builds).

**1. Add the first account.** The first account of a registry owns your normal `~/.claude`.

```
$ claude-account add main --plan ultra
added main: plan ultra (units session 4, weekly 2), dir ~/.claude (the default account), lanes interactive,headless, disabled
registry: /Users/you/.config/claude-accounts/registry.json
sign in as that account on this machine, then check it:
  claude auth login
  claude-account verify main --enable
```

Run the printed login command and sign in with that subscription in the browser, then:

```
$ claude-account verify main --enable
main  login  ok   claude auth status: logged in
main  plan   ok   ultra (tier default_claude_max_20x); login valid until 2027-01-02 (44.0 d left)
main  sample ok   weekly 31% (oauth)
main: verified and enabled in /Users/you/.config/claude-accounts/registry.json
```

**2. Add the second.** It gets its own config directory, `~/.claude-second`, and takes the `bulk` lane (background and batch work); `--dir` and `--lanes` change both.

```
$ claude-account add second --plan max
$ CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude auth login   # `add` prints the exact line (absolute path); sign in with the other subscription
$ claude-account verify second --enable
```

`verify` refuses an account whose login is not the plan you registered (an Ultra added as `max` fails with the `--plan` to use) and one that has no readable quota sample, and
leaves the registry as it is when it fails.

**3. Pick.**

```
$ claude-account pick --lane interactive --why
unset CLAUDE_CONFIG_DIR
# picked=main reason=home stale=false
$ eval "$(claude-account pick --lane bulk)" && claude        # starts claude on the account with the most room for bulk work
$ claude-account rank --lane bulk                           # every eligible account in rule order
$ claude-account usage                                      # 5 h and weekly percent per account, login state
```

`pick` prints a shell line (`export CLAUDE_CONFIG_DIR=…` or `unset CLAUDE_CONFIG_DIR`) or `spill` (exit 3) when no account has headroom. Quota is read with each account's own login, 0 tokens:
`claude-account refresh --all` (run it hourly from cron or launchd) keeps idle accounts' samples and logins alive.

**Taking one out.** `claude-account remove second` disables it and lists what it leaves (the registry entry, the directory, the Keychain login, the cache, the pick history).

## Two machines, a re-login dialog

All of that works with no `host` block. A second machine that shares quota, a re-login ask (a dialog, a message) and a setup command run after `add` are the optional
`host` block of the registry: [`docs/accounts.md` §The host block](../../docs/accounts.md).

## Tests

`bun test packages/accounts`. `test/onboard.test.ts` runs this walkthrough on a temporary HOME with a stub `claude`.
