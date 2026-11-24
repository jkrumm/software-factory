# Claude Code subscriptions: the account picker

`packages/accounts` is the picker for N Claude Code subscriptions as a library and as the `claude-account` CLI: a registry of
accounts, a per-account quota cache, the rule that says which account a new session starts on (rule v1.9, with the
modes of registry v2 as rule v1.10: §Modes), and the logins' health. It is the port of the dotfiles picker (program "subscriptions", `docs/plan.yaml` row
`subs-package`): the same behaviour behind the same CLI contract, installed beside the live CLI as `claude-account-next`
until a switch row moves the callers.

## Contract

The verbs, flags, stdout and `--json` shapes, exit codes and file locations are the dotfiles CLI's, so every reader of this
CLI or its files (the statusline, usage tracker, dashboards, the launchers, the factory's admission) keeps working. `claude-account --help`
lists the verbs, `claude-account <verb> --help` one in full; `claude-account --version` prints the package and its commit
(`@software-factory/accounts 0.1.0 (<sha>)`). Exit: 0 ok, 1 negative answer (`session`, `latest`, `health`, `refresh --all`),
2 usage error, 3 `pick` spill, 4 `pick` with an unreadable registry (it still prints `unset CLAUDE_CONFIG_DIR`).

| What | Where |
|-|-|
| Registry | `$CLAUDE_ACCOUNTS_REGISTRY`, else `~/.config/claude-accounts/registry.json` when it exists, else the dotfiles checkout's `config/claude-accounts.json` |
| Quota cache | `~/.cache/claude-accounts/` (`$CLAUDE_ACCOUNTS_CACHE_DIR`): `<id>.sample.json`, `.exhausted.json`, `.auth.json`, `.verified.json`, `.statusline.json`, `.endpoint.json`, `.refresh.claim`, `.relogin-ask.json` |
| Pick log | `~/.local/share/claude-accounts/picks.jsonl` (`$CLAUDE_ACCOUNTS_PICKS`); usage tracker, the browser extension and the dashboards read it |
| History | `~/.local/share/claude-accounts/` (`$CLAUDE_ACCOUNTS_HISTORY` is the directory): `samples-YYYY-MM.jsonl` and `resets.jsonl` (§History) |
| Mode overrides | `~/.local/share/claude-accounts/modes.json` (`$CLAUDE_ACCOUNTS_MODES`) and its audit `modes.jsonl` (§Modes) |
| Keepalive log | `~/Library/Logs/claude-accounts-keepalive.log`: the stdio of the keepalive job and of the detached refresh a pick spawns |
| Test seams | `$CLAUDE_ACCOUNTS_SECURITY_BIN` replaces `/usr/bin/security`; `$CLAUDE_ACCOUNTS_SSH` and `$CLAUDE_ACCOUNTS_HC` replace the peer's adapters (the owner's `reloginAsk` command reads `$CLAUDE_ACCOUNTS_RELOGIN` for its script) |

## The registry

```json
{
  "fable": null,
  "drain": [],
  "accounts": {
    "main": { "dir": null, "plan": "ultra", "homeLanes": ["interactive", "headless"], "enabled": true },
    "bulk": { "dir": "~/.claude-bulk", "plan": "max", "homeLanes": ["bulk"], "units": { "session": 1, "weekly": 1 }, "loginBrowser": "Google Chrome", "enabled": true }
  }
}
```

- `dir: null` is the account of the default `~/.claude` (`CLAUDE_CONFIG_DIR` unset); exactly one account must own it, and a dir
  set to `~/.claude` explicitly would change the Keychain service and look logged out. Any other dir is that account's config
  dir; its login lives in the Keychain item `Claude Code-credentials-<first 8 hex of sha256(abs dir)>`.
- `plan`: `max` (5 h session window and weekly) or `ultra` (weekly only); the legacy `max5x`/`max20x` read as `max` with units by multiple.
  `units` default from the plan (ultra 4 / 2, max 1 / 1).
- `homeLanes`: the lanes whose spawns start here; an exact lane name wins over a `prefix:*` wildcard. `loginBrowser`: the app a
  re-login opens (data for the relogin command). `enabled: false` ships an account dark until its login exists.
- `policy`: the live picking policy (§The policy lab), absent = `v1.9`. `host`: the optional adapters, §The host block.
- `fable`, `drain`, `version` and an account's `mode`: §Modes. Unknown top-level keys are ignored, so one registry serves this CLI and the dotfiles one.
- The ids are letters, digits, `_` and `-` (they name cache files); `spill` is reserved.

## Layout of the package

| Module | What it holds |
|-|-|
| `policy.ts` | The pure rule: types, `pick`, `rank`, `eligible`, `accountWeight`, `modeOf`, `reserveBudget`, `launchAccount`, the sample merge and parsers, `observedReset`, login grades, `dueIds`, `reloginCandidates`. No file, process, network or clock access (`test/policy-pure.test.ts` fails on one); the clock and the random source are arguments |
| `load-model.ts`, `laxity.ts`, `sim.ts`, `lab.ts`, `measure.ts` | Pure: the policy lab (§The policy lab): the measured load model (`load-model.json`), laxity, the simulation and `compare`'s verdict, the reports and the shadow line, the measurement `scripts/measure-load.ts` writes |
| `modes.ts` | Pure: the override records, their expiry, `resolveModes` and `applyModes` (§Modes) |
| `history.ts`, `history-store.ts` | The sample line, the reset replay and the forecast (pure); the monthly sample log and the ledger on disk (§History) |
| `status.ts` | Pure: `buildStatus`, its schema, the plain lines (§status) |
| `health.ts`, `health-cache.ts` | Pure grading of one machine's `usage` and `expiry` into health rows (a login row carries `ends_at` and `days_left`); the last rows of both machines as `health.json` in the cache directory |
| `registry.ts`, `paths.ts`, `store.ts` | The registry file, every path, the per-account cache files, the claim and stamp files and the override state file |
| `ports.ts` | The ports: `Spawner`, `HttpGet`, `PeerUsage` |
| `keychain.ts`, `oauth.ts`, `claude-auth.ts`, `spawn.ts` | The adapters: the login item through `security`, the usage endpoint, `claude auth status`, processes with a deadline that returns |
| `refresh.ts`, `relogin.ts` | The orchestration over the ports: claim, sample, record; the re-login asks |
| `host.ts`, `owner.ts` | The host block (§The host block): its checks, this machine, the command templates; the adapters behind it: the peer over ssh, the wake push and notification |
| `onboard.ts` | `add`, `verify`, `remove` (§Onboarding): the registry edit, the three checks, what a removal leaves |
| `cli.ts`, `bin/claude-account.ts` | The verbs; the entry |

## The host block

Everything the package does beyond one machine with plain logins sits behind an optional `host` block of the registry (`host.ts`,
`owner.ts`). **Without the block the package runs one machine: no peer import, no re-login ask, no wake notification, no setup command,
and `health` grades this machine alone with its own login command as the repair hint.** The block is checked at load (a bad one makes the
registry unreadable and names the field); keys it does not know are ignored.

```json
"host": {
  "machines": [
    { "match": "mini", "name": "mini",
      "peer": { "name": "macbook", "ssh": ["<peer-alias>"], "fixedVerbs": true, "herdrCore": true } },
    { "name": "macbook",
      "peer": { "name": "mini", "ssh": ["<peer-alias>"], "herdrCore": true },
      "wake": { "push": "<cmd on the peer, {id}>", "notify": "<local cmd, {message}>" } }
  ],
  "reloginAsk": "<cmd, {id} {reason}>",
  "reloginFix": "claude-relogin {id} --machine {machine}",
  "afterAdd": "<cmd, {id} {dir} {plan}>"
}
```

| Key | What it does | Seam for tests |
|-|-|-|
| `machines[]` | This machine is the first entry whose `match` (a case-insensitive regex over the hostname) fits, else the first without a `match`; no fit, no peer. `name` is the machine in audit lines and health rows | |
| `peer` | The other machine, reached with ssh (BatchMode, 5 s connect). `refresh` reads its `claude-account usage --json` once per run (20 s cap) and imports its samples; `health` reads its snapshot. `bin` is its claude-account (default `$HOME/.local/bin/claude-account`); `fixedVerbs`: its key runs the verbs `account-usage`, `account-snapshot`, `account-snapshot-core` only; `herdrCore`: `health` goes through the herdr-cores first, plain ssh only when none answers (a NOTE line says so) | `CLAUDE_ACCOUNTS_SSH`, `CLAUDE_ACCOUNTS_HC` |
| `wake` | `health --wake` runs `push` on the peer per pending re-login ask younger than 24 h, and `notify` locally when the picture of non-ok rows changed (once per 12 h for the same one) | |
| `reloginAsk` | `refresh --all` starts it detached for a dead login or one inside its last 7 days: once per 24 h per account, once per hour per machine, never an auto-run. Whatever asks the human (a dialog, a chat message) is the command's business | |
| `reloginFix` | The repair hint of a `health` row. Absent: this machine's own login command (`claude auth login`, with `CLAUDE_CONFIG_DIR` for another dir) | |
| `afterAdd` | Runs once after `add` wrote the entry and created the directory: machine setup such as rendered settings or MCP registration. `$CLAUDE_ACCOUNT_ID`, `_DIR` and `_PLAN` are set too. A failing command leaves the account registered and `add` exits 1 | |

Commands are shell templates run with `sh -c`; a `{placeholder}` is replaced by the value, shell-quoted (`reloginFix` is shown, not run, and takes it as it is).
`loginBrowser` on an account is data for the `reloginAsk` command. The owner's registry gets the block that keeps what the package did on his
two machines before the block existed (`test/owner-host.ts` is that block, the registry's copy lands with the dotfiles Issue that files it; the CLI tests and the parity fixtures run with it, and the golden outputs of
`health`, `refresh` and `expiry` are unchanged).

## Onboarding

```
claude-account add <id> --plan <max|ultra> [--dir <path>] [--lanes <a,b>]
claude-account verify <id> [--enable]
claude-account remove <id>
```

- **`add`** writes a disabled entry and creates the config directory. The first account of a registry takes the default `~/.claude` (`dir: null`) and the lanes
  `interactive,headless`; every later one takes `~/.claude-<id>` and `bulk`. `units` is never written (it comes from the plan table; the key only overrides).
  The registry is `$CLAUDE_ACCOUNTS_REGISTRY`, else the per-user file `~/.config/claude-accounts/registry.json` (created when there is none), else the dotfiles
  file a machine already uses; a symlink is written through, keys the package does not know stay. It prints the login command for this machine
  and the `verify` command, then runs `host.afterAdd`. It refuses an id that is taken, a plan other than `max` and `ultra`, a dir another account uses and `~/.claude` named explicitly.
- **`verify`** checks on this machine, in order: *login* (`claude auth status` for the account's config dir), *plan* (the tier of its Keychain login item is the registered plan: an account added as `max` whose login is an Ultra
  fails, with the `--plan` to add it again with), *sample* (a weekly quota sample: the usage endpoint with the account's own token, else the account's own cached usage; it lands in the cache). A disabled account is checked all the same.
  `--enable` enables it when all three pass; exit 1 and the registry is left as it is otherwise.
- **`remove`** sets `enabled: false` (no pick, rank or refresh touches it) and lists what it leaves: the registry entry, the config directory, the Keychain login (with the logout command),
  the cache files and the history. Running it again changes nothing. Deleting those is the user's: the package never removes a login or a directory.

`packages/accounts/README.md` takes a new user from nothing to a first pick with two accounts.

## Quota sources

**Quota sources: read-only use of the account's own token for one GET, plus a peer import.** Four feeds; **one weekly figure per account: the newest usable reading across the statusline, the peer sample and the endpoint's `weekly_all` limit wins** (`settleWeekly`, applied on every merge and every load, a tie keeps the window; no usable reading from any source is still `no-sample`), all
written into `~/.cache/claude-accounts/` as one small file per account and kind (`<id>.sample.json`, `<id>.exhausted.json`, `<id>.auth.json`, `<id>.refresh.claim`; no lock, each writer replaces only its own file atomically, windows carry their own timestamps):

1. **Statusline (live, free):** every render gets native `rate_limits` for the
   session's own account; a hook feeds them in with `claude-account record`. While any session runs on an account,
   its numbers are seconds old.
2. **Limit events (instant):** a hook marks the account exhausted until `resets_at` with `claude-account exhausted`
   the moment a wall is hit. No poll needed to learn about a wall.
3. **Idle accounts:** `GET https://api.anthropic.com/api/oauth/usage` (headers `Authorization: Bearer`, `anthropic-beta:
   oauth-2025-04-20`, as in `fetch_usage.py`) with that account's own Keychain token: service `Claude Code-credentials`
   (default dir) or `Claude Code-credentials-<sha256(abs dir)[:8]>`, read with `security find-generic-password -s <svc> -w`
   (`claudeAiOauth.accessToken`). 0 tokens, no window priming, 10 s timeout, in-process. The token is used for that one
   request and nothing else: never copied, logged, written to the cache or written back to the Keychain (invariant 2: we
   never become co-owner of the login). `utilization` / `resets_at` of `five_hour` / `seven_day` become the sample
   (`src: oauth`). A body with no `seven_day` (the ultra plan's, seen 2026-11-22) carries its weekly figure in the
   `weekly_all` entry of `limits[]` (`percent`, ISO `resets_at`): that becomes the weekly window (`w_src: limits`), so an
   answered call is a sample. Each refresh also writes `<id>.endpoint.json` (`{at, status, outcome}`; outcome `ok`, `auth` for
   HTTP 401/403, `no-weekly`, `http`, `unreachable` or `no-token`): what `health` reads to say why a sample is old. Any failure (Keychain locked or denied, HTTP 401/429/5xx, unparseable body) means *no sample* and
   never an auth mark: a locked Keychain or a 429 proves nothing about the login, so the run falls through to the
   `claude auth status` verdict (§Operate, Login keepalive). One failure is repaired instead: **HTTP 401**. The Keychain
   access token of an idle account expires and nothing renews it (seen live 2026-10-25: `me` idle 01:01 to 08:27, sample
   8.5 h old, out of routing). `claude auth status` for that account's `CLAUDE_CONFIG_DIR` (0 tokens) makes the binary
   renew the token in the Keychain, so a 401 runs it, re-reads the token and retries the GET once; a second failure is
   plain "no sample". That one `auth status` is also the run's login verdict (never run twice), so the auth mark logic is
   unchanged: only a verdict, a sample or a statusline record moves it, and no token reaches a log or a file. A refresh runs
   only when an account's newest sample is older than 10 minutes, at most once every 5 minutes per account (the claim,
   unchanged), because the endpoint rate-limits per token (a 429 can block for up to an hour: claude-swap, ClaudeBar). `claude -p "/usage"` was the source until Claude
   Code 2.1.310; it now prints an analysis and no longer updates `cachedUsageUtilization`, so it is gone.
   `readClaudeJson` still merges whatever `cachedUsageUtilization` the binary writes during real sessions (newest
   timestamp wins).
4. **Peer machine (import, refresh only):** quota is per account, not per machine, so the other machine's numbers are as
   good as ours. Seen 2026-10-27: a laptop's `me` had no sample for 36 h (idle Keychain access token expired, every GET 401,
   and `claude auth status` in 2.1.311 no longer renews it) while the server, where `me` is busy, had fresh ones.
   `runRefresh` (keepalive `--all` and the detached pick-time refresh) first fetches the peer's `claude-account usage
   --json` once (ssh, 20 s cap; §The host block) and turns each row of a locally registered, enabled account into a sample (`src: peer`).
   Each window's timestamp is rebuilt from the row's age (now minus `*_age_s`; null age, null timestamp), so an old
   number is never laundered into a fresh one, and `mergeSample` keeps the newer window. A full endpoint answer (`src: oauth`) with a weekly window but no `five_hour` drops the stored session half instead of keeping it frozen; the other feeds only omit. A future `exhausted_until`
   is imported as a mark. **Auth state is never imported** (logins are per machine): an account served from the peer still
   gets its own `claude auth status` verdict. An account whose merged sample is now younger than 10 min skips the
   endpoint GET for that run and counts as `fresh` only when this machine's verdict says logged in (no verdict:
   `unresolved`, the keepalive's exit 1). An unreachable or garbled peer is one log line and the run continues
   unchanged. It runs only in the keepalive and the *detached* pick-time refresh; the synchronous refresh a
   non-interactive pick may wait for skips it, so no pick ever waits on ssh.

## The picker

```
claude-account pick --lane <lane>   # prints "export CLAUDE_CONFIG_DIR=…" or "unset CLAUDE_CONFIG_DIR"; no headroom: prints "spill", exit 3 (the interactive lane lands on the default account instead, step 6, with a warning on stderr)
claude-account rank --lane <lane> [--json]   # the deterministic order of every eligible account (iterated `pick --dry`), a pure read
claude-account usage [--json]       # every account: 5h % (not for Ultra), 7d %, resets, auth ok; a file read
claude-account expiry [--json] [--ids a,b]   # when each login ends (refresh token), graded PASS / WARN / FAIL
claude-account env <id>             # force an account
```

`expiry` rows carry `grade` (PASS > 7 d, WARN <= 7 d or unreadable, FAIL <= 2 d or past), `default`, `severity` (the grade; a
non-default account never exceeds WARN), `tier` and `plan_detected`. `usage` stays a pure file read (the statusline calls it);
`expiry` is the only reader of the Keychain item's timestamps and tier, and no token field is ever read or exposed there.

**Rule v1.9** (v1.8 plus the 72 h expiring horizon, 2026-11-19: step 1 serves the earliest weekly reset first among accounts resetting within 72 h (`EXPIRING_S`), where it looked 24 h ahead; the 98 % ceiling keeps its own 24 h (`CEILING_EXPIRING_S`); v1.8 = v1.7 plus the drain-to-the-end change, 2026-11-18: `weeklyMax` is 100 in the last 3 h before the reset and step 1 lost its 70 % cap, so an expiring account keeps taking bulk work up to its ceiling; v1.7 = v1.6 plus the step-5 pace guard; v1.6 = v1.5 plus the 5h guards below, 2026-10-30; v1.4 plus expiry-weighted sharing below; ceilings tightened 2026-10-27: `SESSION_MAX` 85 → 90, `WEEKLY_MAX` 90 → 95, to use more of each subscription; v1.3 plus N accounts: where v1.3 took the first match in registry order for every alternative, v1.4 takes the best one; v1.3 = `weeklyMax(x)` 98 while x's weekly window resets within 24 h, else 95, the last points of an expiring window being use-it-or-lose-it, decided 2026-10-27 after `iu` sat idle at 93 % with 14 h to its reset; v1.4 decided the same day when `me2` joined):

```
eligible(x) = enabled ∧ auth_ok ∧ not exhausted ∧ session% < 90 ∧ weekly% < weeklyMax(x) ∧ sample age < 6 h
              (sample > 10 min old: `pick` uses it and refreshes in the background on EVERY lane, interactive
               included, detached and budgeted; a refresh takes a couple of seconds. Only a non-interactive lane
               refreshes an account with no usable sample synchronously; the interactive pick never waits.
               The pick log carries `stale: true`)
pace(x)     = 100 × elapsed share of x's 7-day window (seven_day_resets_at, clamped 0..1)
overPace(x) = eligible(x) ∧ weekly%(x) > pace(x) + 15      # PACE_MARGIN; no weekly reset → never over pace
units(x)    = registry units, else from the plan: ultra {4, 2}, max {1, 1}; legacy "maxNx": k = max(1, N/5) → {session k, weekly 1 + (k−1)/3}
              (max5x {1,1}, max10x {2, 1.33}, max20x {4, 2}); any other plan → {1, 1}
session%(x) = x's 5 h percent when its plan has a session window and the sample is < 6 h old, else absent
              (Ultra: always absent; every session% term below is then skipped: no block, no demotion, no session move)
spare(x)    = (weeklyMax(x) − weekly%(x)) × units(x).weekly     # no weekly window → WEEKLY_MAX × units.weekly
weight(x)   = spare(x) / hoursToWeeklyReset(x)^1.5    # URGENCY_EXP; ≥ 1 h; no weekly reset → a full week
best(S)     = the member of S with the highest weight (registry order breaks ties)
share(S)    = a draw from S with probability ∝ weight   # what the CLI uses; `pick --dry` and tests use best(S)
home(lane)  = share(eligible x whose homeLanes claim the lane)
              iu for interactive, headless
              me and me2 for bulk (only the lane named `bulk`; any other lane name has no home and picks by headroom. Factory spawns carry the picked-marker, so `USAGE_LANE=batch` there is only a usage label)
coolSet      = eligible accounts with session% < 80 (SESSION_SOFT_MAX), else all eligible   # a hot 5h window is the last choice, not excluded
                 every step below reads coolSet as "eligible"
pick(lane):
  0. ∃ cool drain account → share(those)   # drain mode (registry `drain`), every lane, weekly ceiling 100
  1. bulk lane ∧ ∃ eligible x with weekly reset < 72 h → x   # use expiring capacity first (soonest reset); no weekly% cap since v1.8, 72 h since v1.9
  2. eligible(home) ∧ overPace(home) → share(eligible x ≠ home ∧ ¬overPace(x))   # pace guard, every lane
  3. eligible(home) → the eligible x ≠ home with (¬overPace(x) ∨ session%(home) ≥ 60) ∧ session%(home) − session%(x) > 20
                      and the lowest session% (ties by weight); a sibling that shares the lane beats an outsider
                      # balance the 5h windows
  4. eligible(home) → home
  5. share(eligible x ∧ ¬overPace(x), else eligible)   # spill to the accounts with the most room, calm ones first (v1.7)
  6. interactive → iu (Claude Code shows the limit itself; `pick` says so on stderr)
     bulk        → "spill": the caller spills to its IU path
                   (`rd` pauses — Herdr work never spills to IU, agw steps keep their IU path)
```

Why v1.4: with two accounts "the other" was one account, so the first match was the only match. With `me2` the
siblings `me` and `me2` share the bulk lanes, and registry order would have drained `me` while `me2` idled. Headroom
is the weekly points left below the account's own ceiling, scaled by its plan, so a 20x account with the same
percent counts for twice the room. Every threshold and the expiring-capacity step are unchanged. From v1.5 the ranking is
spare per hour to the account's own reset (a reset already past counts as a fresh week), and the CLI's draw is random
(only the outcome reaches the pick log, so a single pick is not reproducible; `pick --dry` and the tests stay deterministic).

Why v1.5 (2026-10-29): the pick log showed `me2` at 67 % weekly with three days to its reset taking about a tenth
of the bulk picks while `iu` and `me` (resets 6-7 days out) took the rest. v1.4's best-headroom pick looked at spare
points only, so an account that expires sooner was no more attractive than one that expires next week, and
argmax sends a whole burst of spawns to one account. v1.5 weighs each account's spare capacity per hour to *its own*
reset (sharpened ×1.5, so a window closing sooner counts for more), and the CLI draws among the home accounts in
proportion to the weights, so a burst spreads instead of landing on one account. Nothing names an account or a plan:
a new subscription is a registry entry, its reset time and quota come from the sample. With `me` and `me2` at
similar 5h load the split at the time was about 49/51; the 5h-balance step (3) still moves work to the emptier
window and keeps overriding the weekly weighting while the 5h loads differ by more than 20 points.

Why v1.9 (2026-11-19): `packages/accounts/test/sim.test.ts` runs the rule for three weeks against sticky sessions, a day/night
demand curve and the real reset offsets, and judges it by the weekly % each account reaches at its reset. At demand 0.85× the
pool the 24 h horizon ended iu at 88-92 %, me2 at 88-95 % and me at 64-67 %; 72 h ends iu and me2 at 99-100 % and leaves the slack
on one account (me, about 40 %). Below the pool's size the slack has to land somewhere, and earliest-reset-first lands it on
the fewest accounts. At 1.0× and above both horizons fill every window to 91-100 %. 120 h and 168 h added mid-session walls
(moved sessions) without a better result. The same file models the factory's own choice (`roomLeft`, most room in the tightest
window): it leaves every account at 75-98 % at its reset, which is what 2026-11-18 showed (me 93 % at its reset). The suite
asserts these outcomes, so a rule change that wastes quota fails `make check-fast`.

Why v1.8 (2026-11-18): `iu` reached its reset at 90 % (83 % a day earlier). Eligible under the 98 % ceiling, it was never chosen: step 1
skipped any account above 70 %, the bulk lanes sat on `me`/`me2` at step 4, and 98 % left the last points unspent. Expiring capacity now
has no weekly cap, and the ceiling is 100 in the last 3 h (a wall hit then costs under 3 h).

Why v1.7 (2026-11-18): `me2` went from 43 % to 86 % weekly in a day at 43 % pace and then sat at its wall for days, while `iu`
(which already ends its weeks at 90-98 %) took the rest. Homeless lanes (factory `lead`, `headless` overflow) land in step 5, the only
step without a pace guard, and a lead is a long session that drags its workers onto the account it was drawn for (a Fable account added to it; the pick log cannot separate the two). Step 5 now draws
only among accounts not over pace and falls back to all of them when every candidate is over pace.

Why v1.6 (2026-10-30): all three accounts sat over weekly pace (`iu` 41 % vs 27 % elapsed, `me` 42 vs 18, `me2` 94 vs 68),
so step 3 had no candidate and `me` (5h window a quarter of `iu`'s) took every bulk spawn from 3 % to 99 % in 75 minutes while
`iu` idled at 5 %. A full 5h window is a wall; an over-pace week is a preference (it recovers over a weekend). So (a) the
session move ignores the other's pace once the home 5h is at 60 % (`SESSION_PRESSURE`), and (b) from 80 %
(`SESSION_SOFT_MAX`) an account only takes work when no cooler one is eligible; `SESSION_MAX` 90 stays the hard stop.

Why the pace step (v1.1): on 2026-10-24 `c` picked `iu` at 89 % weekly with about
four days to its reset while `me` sat at 2 %. v1 only leaves home at weekly ≥ 90 %,
so interactive work burned iu's last 11 % while `me` idled. An over-pace home now
yields to an under-pace account (iu 88 % at pace 44 → `me`, reason `pace`). Picks
are per spawn, so no hysteresis. Expiring capacity (rule 1) still wins for bulk lanes.

Why the session step (v1.2): `me`'s 5h window is a quarter of `iu`'s and runs out
fast, so an idle `me` window is capacity that is gone at the next reset. A spawn moves
to the other account when its 5h is more than 20 points emptier (`SESSION_MARGIN`)
and it is not over weekly pace; reason `session`. Within the margin home stays, so
cache and routing remain stable.

Why the refresh is not interactive-exempt (v1.2 text, 2026-10-25): v1.1 left the interactive lane untouched so a
pick could never block or spend anything. That exemption starved an idle account: on a machine where only interactive
picks run (the MacBook) nothing ever refreshed `me`. The refresh itself is cheap (one usage GET or `claude auth status`,
0 tokens), so the lane now spawns the same detached, claimed (5-min budget) background refresh as the others and still
never waits: the pick answers from the cache it has, the next one sees the new sample. The rule itself is unchanged.
The periodic keepalive (§Operate) is the guarantee; the pick-time refresh is the opportunistic second path.

Why these homes: bulk work is steady, unattended and starts a fresh context
per spawn, so each spawn is a free re-pick point. Together they are 63% of Max
spend, which fits `me`'s small session window better than bursty interactive work
does. `me` cannot hold all of it (its weekly is about half of `iu`'s); `me2` takes the share
`me` cannot, and step 5 spills the rest to `iu`, which gains headroom because the bulk work left it.

Every decision is appended as JSONL (`ts, lane, picked, reason, stale`, and `{s, w}` per account id) to `~/.local/share/claude-accounts/picks.jsonl`. That pick log is the dataset for v2 tuning.

**v2 (later, from data):** replace the fixed thresholds with pace.
`projected_w(x) = weekly% + burn_rate(lane mix) × hours_to_reset`. Pick the
account with the most slack left at its own reset, which spends capacity before
it expires. Upgrade `me` to 20x if its weekly stays > 80% two weeks running.

## Modes

Each account is in one mode (registry v2, rule v1.10; Spec of the `subs-model-v2` row, kept in the history of `docs/plan.yaml`). The mode in force is the live
override (§Overrides), else the account's registry `mode`, else the v1 keys (`drain: [<id>]` reads as drain, `fable: <id>` as
reserve for fable), else normal. `modeOf` (`policy.ts`) is the one place that answers it; `resolveModes` (`modes.ts`) adds the
override and its source, and `applyModes` hands the rule a registry with the live overrides in place.

| Mode | Takes work from `pick` / `rank` | Sampled, login checked |
|-|-|-|
| `normal` | rule v1.9 as above | yes |
| `drain` | first in every lane while its 5h is under `SESSION_SOFT_MAX` (reason `drain`; several share by weight), weekly ceiling 100 | yes |
| `reserve` for `<model>` | `hold: account` (default): last resort for every pick; `hold: allowance`: only inside its reserve budget (§Reserve). The model's launcher lands here | yes |
| `paused` | never (`eligible` is false) | yes |

`enabled: false` stays what it was: an account that is not set up, neither sampled nor checked. The one exception to "never
picked" is the interactive fallback (step 6): it lands on the default account whatever its mode, and Claude Code shows the limit.

### Reserve

A reserve carries `hold: account | allowance` (owner decision 2026-11-19: Fable mode keeps the whole account for the model, and the owner resets
its Fable usage by hand, so the 50-point allowance is not what binds). The default is `account`, and the v1 `fable: <id>` key reads as it.

- **`hold: account`:** the account is the last resort for every pick except its model's launcher, whatever its budget or the time to its
  reset: v1's Fable mode exactly (reason `<model>-reserve`, last in every lane of `rank`, taken only when no other account can take the work).
  It has no budget; `mode` lists it as "holds the account".
- **`hold: allowance`:** the account holds back only the unused part of its model's weekly allowance, below.

The usage endpoint gives the allowance:
`limits[]` has a `weekly_scoped` limit whose `scope.model.display_name` (or `id`) names the model, and `weekly_scoped_shares[]`
gives its `used_percent_of_weekly` and `allowance_percent_of_weekly` (50 for Fable on every account, checked 2026-11-19): the
model's use counts against the weekly limit and resets with it. For `hold: allowance`, with a scoped sample younger than 6 h (`reserveBudget`):

```
unused = max(0, allowance − used)          0 in the last 24 h before the weekly reset (RESERVE_RELEASE_S: the allowance is released)
open   = weekly + unused < weeklyMax       (95, 98 in the last 24 h, 100 in the last 3 h)
```

- Open (`hold: allowance`): the account takes its normal place in the rule; its weight counts only `weeklyMax − weekly − unused`.
- Closed: other work is refused, not even taken as the last resort. Bulk spills; interactive falls back to the default account.
- No fresh scoped sample: the budget is unknown and the account is the last resort, as v1's Fable mode (reason `<model>-reserve`).
- **Launcher:** `claude-account fable` (what `cf` evals) prints the open reserve-for-fable account (eligible, scoped percent under 100)
  with the most unused allowance; none open → the first enabled reserve-for-fable account; none → the default account.
  `cf --account <id>` still wins.

**Where a v1 registry picks differently from v1.9.** Nowhere: `fable: <id>` is `hold: account`, so every lane picks and ranks as v1.9
(`test/parity.test.ts`). Only a reserve set to `hold: allowance` differs, and only with a fresh scoped sample (the endpoint GET fetches it,
below): inside the budget it takes its normal place (iu, the default, is the interactive and headless home again) where v1.9 put it last;
over the budget it is refused where v1.9 took it as the last resort; in the final 24 h it is a normal account. The scoped sample is still
fetched for `hold: account`: the launcher picks among reserves by it.

The statusline feed carries no scoped limit, so a reserve account is due for one endpoint GET when its `limits_ts` is older than
30 min (`SCOPED_FRESH_MS`), even while its windows are fresh; the 5-min claim still binds (at most 48 GETs a day per reserve
account and machine). A stale scoped number counts the model's use twice (in `weekly` and in `unused`), so staleness costs
room, never the reserve. Samples keep `limits`, `scoped_shares` and `limits_ts` beside the windows; the merge keeps the newer set.

### Expiry

A mode can carry `until`: an ISO time, `reset` or nothing. `reset` (overrides only: a committed file has no time it was set) ends at
the earliest of: the scheduled weekly reset it was set in (`baseline_w_reset`, the sample's reset when set, moved a week on while
it lies in the past), a sample whose weekly reset lies more than a day past it, or an **observed reset** after it was set. A reset
is observed when a written sample's weekly reset moved forward by more than 24 h or its weekly percent fell by 50 points or more
(`observedReset`); `<id>.reset.json` keeps the latest (`{at, w_before, w_reset_before, w_reset_after}`). So a manual reset ends a
drain as a scheduled one does. A weekly window the recorded reset already closed, read late (its reset time is the closed window's or
earlier, its percent 50 points or more above the cache's), never replaces the cache (`staleAfterReset`): one reset is one ledger row, and
the next fresh sample is no second reset. An expired override is skipped where it is read, and the next `refresh`, `record` or `mode`
writes it down once: a tombstone (stamped as the record it ends, so an override set later still wins) and an `end` line in `modes.jsonl`. `mode <id> drain`
without `--until` is until reset; the other modes have no expiry by default.

### Overrides

```
claude-account mode [--json]                    # every account: mode, source (override | registry), until, set, why, a reserve's hold (holds the account, or its budget)
claude-account mode <id> <normal|drain|reserve|paused> [--for <model>] [--hold account|allowance] [--until reset|<iso>] [--why <text>]
claude-account mode <id> --clear
```

An override is a record in `~/.local/share/claude-accounts/modes.json` (`$CLAUDE_ACCOUNTS_MODES`), one per account, written
atomically, with one audit line per set, clear, adoption or end in `modes.jsonl` beside it:

```json
{ "version": 1, "accounts": {
  "me2": { "kind": "drain", "for": null, "until": "reset", "why": "empty before the manual reset",
           "set_at": 1795080000000, "set_on": "mini", "baseline_w_reset": 1795370400 },
  "me":  { "cleared": true, "set_at": 1795081000000, "set_on": "macbook" } } }
```

It is a last-writer-wins register per account: the newer `set_at` wins, ties go to the later `set_on`, and a clear is a tombstone
so it wins on the other machine too. `usage --json` carries each account's record as `mode_override`, and the peer import
(`refresh`, both directions) adopts the newer one. On the machine that set it an override shows in `rank` at once; on the other
after its next refresh (the hourly keepalive, or a pick-time refresh). `normal` as an override switches a registry mode off.

### Registry v2

v1 plus two optional fields. `version`: absent, 1 or 2; any other value is "registry unreadable" (`pick` exit 4 with the default
account, every other verb exit 2). `accounts.<id>.mode`: a kind (`"paused"`) or `{kind, for, hold, until, why}`; `for` is required for
reserve and only there; `hold` (`account`, the default, or `allowance`) is for reserve only; `until` is an ISO time. An account's own `mode` wins over `fable` and `drain`, which keep their v1
meaning and check (one account cannot be both).

### `usage --json` (additive)

`usage --json` rows gain `mode` (`{kind, for, hold, until, until_at, why, source, set_at, set_on}`, the mode in force; `hold` is `account` or `allowance` for a reserve, else null), `mode_override`
(the raw record, a tombstone included, or null), `limits` and `weekly_scoped_shares` (as the endpoint gave them, each with
`age_s`, or null; the `weekly_all` entry also `in_force`: true when it is the `seven_day` figure, false when a newer reading superseded it),
`seven_day_source` (the feed the `seven_day` figure came from) and `endpoint` (`{outcome, status, age_s}` of this machine's last usage-endpoint call, or null).
`health`'s quota row names that outcome: "token rejected" only for `auth`, and a re-login is its fix only for `auth` and `no-token`. Every other field and the plain text are unchanged.

`claude-account status [--json] [--resets]` is the read model (§status). `usage --json` stays as it is.

With `"fable": "iu", "drain": ["me2"]` and no scoped sample the order is me2 (drain), then me, then iu (fable-reserve) in every
lane; the simulation fills me2 within 3-4 hours and keeps iu under 65 % for the week.

## History

The cache holds only the latest sample of an account, so the package keeps its own record, with no database: two files under
`~/.local/share/claude-accounts/`, written by whichever machine writes the sample (statusline record, endpoint GET, peer import), so a
machine's history is what it saw.

| File | One line per | Fields |
|-|-|-|
| `samples-YYYY-MM.jsonl` | change of a percent or a reset time of one of the account's limits (a reset time that moves by under a minute is the same) | `ts` (epoch ms the values were true: a peer sample keeps the time it was taken, not the time it arrived), `id`, `s`, `s_reset`, `w`, `w_reset` (epoch s), `scoped` (the highest scoped percent, null without an endpoint sample), `src`, `mode` (kind in force), `rule` |
| `resets.jsonl` | observed weekly reset of an account | `key` (account and reset time rounded to 10 min), `at` (the scheduled reset, or the first sample that showed it when that came earlier: a manual reset), `reset_at`, `weekly` and `scoped` (the last percent before it), `modes` (the modes seen that week), `rule`, `closed_hours` (hours the account stood at or over its weekly ceiling in that week; a drain's ceiling is 100), `manual` (more than an hour before the schedule) |

A reset is what `observedReset` calls one (§Expiry), judged between two consecutive lines. A manual reset shows twice, the percent
first and the new reset time a sample later: both are one ledger line (same `key`), and a repeated line, a peer's echo of a
state already logged or a shuffled order add none. The ledger is derived from the log (`replayResets`): `history` brings it up to
date, a writer appends the line of a reset it sees, and a key that is there is never added again. Nothing is rotated out of the ledger;
the sample log is a file per month and `status` reads the last 40 days. A write to the history is a record, never a gate: a failure
leaves the sample written and the verb running.

```
claude-account history [--json] [--id <id>] [--days n]   # the ledger of the last n days (28)
claude-account history import <file>                      # sample lines (JSON per line) into the log; a line at a time the log has is skipped
```

The import seeds the weeks from before the history existed: a throwaway conversion of usage tracker's quota series
(`make -C ~/SourceRoot/usage-tracker quota DAYS=<n>`) into `{ts, id, s, s_reset, w, w_reset}` lines, run once; it is not shipped.

### Forecast

`forecastWeekly`, method `burn-rate-24h-v1` (`status` names it): the rate is the weekly percent gained over the last 24 hours of the
running week (since its first line when the week is younger, never over less than 3 h), held to the reset.

```
weekly_at_reset = min(100, weekly + rate × hours to the reset)       full_at = when weekly reaches 100 at that rate (the time it did, when it is there)
waste_percent   = 100 − weekly_at_reset        waste_units = waste_percent / 100 × the plan's weekly units   # an Ultra's 2 units weigh double a Max's
```

It is a projection of the burn so far, not of the rule: it does not know the ceiling (95, 98, 100) or a mode, and an account that
the rule holds back reads as one that stops burning. The goal it measures is the one the owner set: every account near 100 % at its reset.

## status

`claude-account status [--json] [--resets]`: a file read (no Keychain, no network), computed by `buildStatus` in `status.ts` over the
registry, the cache, the modes in force, the history and the clock, so every display reads one definition of "takes work, and why".

Plain: one line per account, led by the forecast: `me2 drain until reset · weekly 92 % · full Fri 14:00 · resets Sat 18:00` (times are the
machine's local time); a forecast that does not fill the week says `ends at 88 % (0.12 units unused)`; a closed account ends with
`closed: <why>, opens <time>`. `--resets` adds each account's last resets.

`--json` is `STATUS_SCHEMA` (`status.ts`; `test/schema.ts` validates it):

```json
{ "schema": 1, "at": "<iso>", "machine": "mini", "rule": "v1.10", "default_account": "iu",
  "lanes": ["interactive", "bulk", "headless", "other"],
  "accounts": [{
    "id": "me2", "plan": "max", "units": {"session": 1, "weekly": 1}, "enabled": true, "auth_ok": true, "exhausted_until": null,
    "limits": [{"kind": "session", "percent": 51, "resets_at": "<iso>", "age_s": 30, "source": "statusline"},
               {"kind": "weekly_all", "percent": 97, "resets_at": "<iso>", "age_s": 30, "source": "statusline"},
               {"kind": "weekly_scoped", "model": "Fable", "percent": 6, "resets_at": "<iso>", "age_s": 900, "source": "oauth",
                "allowance_percent_of_weekly": 50, "used_percent_of_weekly": 3}],
    "mode": {"kind": "drain", "for": null, "until": "reset", "until_at": "<iso>", "why": "…", "source": "override",
             "set_at": "<iso>", "set_on": "mini", "expired": false},
    "reserve": null,
    "closed": null,
    "lanes": {"bulk": {"open": true, "position": 1, "reason": "drain", "closed": null, "why": null, "opens_at": null}},
    "forecast": {"method": "burn-rate-24h-v1", "weekly_at_reset": 100, "full_at": "<iso>", "waste_percent": 0, "waste_units": 0, "burn_per_hour": 1.4, "basis_hours": 24},
    "resets": [{"at": "<iso>", "weekly": 99, "scoped": 12, "modes": ["drain"], "rule": "v1.10", "closed_hours": 3.5, "manual": false}] }],
  "health": {"at": "<iso>", "rows": [{"machine": "mini", "id": "me", "check": "login", "state": "warn", "detail": "login ends in 6.9 d",
                                     "fix": "claude-relogin me --machine mini", "ends_at": "<iso>", "days_left": 6.9}]} }
```

- `health` is `claude-account health`'s rows as the last run left them (`health.json`; `null` before the first): `health` writes it on every run and the
  keepalive (`refresh --all`, hourly) writes it too, so a reader that must not reach the peer itself (the factory server) shows the logins of both machines and
  the age of the read (`at`). `status` grades nothing: the state of a row is `health.ts`'s. The file is additive; the parity tests leave it out.

- `lanes` is `interactive`, `bulk`, every exact home lane and `other` (a lane no account claims). `position` and `reason` are `rank --lane`'s
  (test: the order of every lane equals rank's); an account `rank` does not list is closed there.
- `closed` (top level and per lane) is one of `disabled`, `paused`, `auth`, `no-sample`, `session-max`, `weekly-ceiling`, `exhausted`,
  `reserve-budget`: the first that applies, the same checks as `eligible` plus the reserve budget (`closure` in `policy.ts`, tested against `rank`
  over random registries of 1 to 8 accounts). `why` says it in words and `opens_at` when it takes work again as far as the sample says: the 5 h
  reset, the moment the weekly ceiling rises (98 in the last 24 h, 100 in the last 3 h) or the reset, the end of an exhausted mark, the release
  of a reserve's allowance 24 h before the reset. Null when only a person opens it (a login, a mode, `enabled`).
- One quirk of `rank`, kept as it is: with no account open the interactive lane lands on the default account, which `rank` lists as
  `<model>-reserve` when that is a reserve account, whatever its sample says; `status` shows that place as it is.
- `reserve` is `{for, known, unused, budget_left, released}` for a reserve account, `forecast` null without a weekly sample, `resets` the last 8
  ledger lines, newest first. The rule is `RULE_VERSION` (`v1.10`: v1.9 with the modes), `v1.10+<policy>` under a policy other than `v1.9` (§The policy lab), as the sample log names it.

## The policy lab

```
claude-account simulate [--policy <name>] [--demand <x>] [--accounts <n>] [--weeks <n>] [--seed <n>] [--json]
claude-account compare [--weeks <n>] [--json]
bun packages/accounts/scripts/measure-load.ts [--from <iso>] [--to <iso>]   # re-measures src/load-model.json
```

A **policy** is a named pure function over the picker's snapshot (`pickWith(name, {reg, cache, lane, nowMs, rng, load})`,
`POLICIES` in `policy.ts`). The registry's top-level `policy` names the live one; absent, it is `v1.9`, and a name the build
does not know is refused at load. Every policy is rule v1.9 with its expiring-capacity step varied:

| Policy | Bulk lanes, before the v1.9 home and spill steps |
|-|-|
| `v1.9` | the earliest weekly reset among accounts resetting within 72 h |
| `laxity` | the **due** account with the least slack, else v1.9's step |
| `laxity-pure` | the due account with the least slack, and no fixed 72 h step |
| `v1.9-cool` | v1.9's step, skipping an account whose 5 h window is at 60 % or more |

**Laxity** (`laxity.ts`): an account's slack is the hours to its weekly reset minus the hours it needs to fill the rest of its
week to 100 %, hour by hour at the rate it can absorb: the smaller of what its 5 h window lets through (one full window every
5 h, the measured weekly points per 5 h point times its session units) and the bulk lanes' share of the pool's demand on the
measured day and week curve. Due means a slack of 0 h or less. The live picker reads the measured demand; the simulation hands
it the demand it simulates.

**The sample log's `rule`** is `v1.10` under the default policy and `v1.10+<policy>` under another one, so the reset ledger
records which policy each week ran under; `compare` groups the ledger by it (weeks before 2026-11-19 carry no rule:
`unrecorded`).

**The shadow log** `~/.local/share/claude-accounts/shadow.jsonl` (`$CLAUDE_ACCOUNTS_SHADOW`, beside the pick log, which keeps its
shape): every live pick (not `--dry`) appends `{ts, lane, policy, picked, shadowed: [the other policies], differs: {<policy>:
<account>}}`. Each other policy decides over the same snapshot and replays the live pick's random draws, so a difference is the
policy's, not the dice's. `compare` reports it as a disagreement rate only: a pick that was not made has no outcome.

### The load model

`src/load-model.json`, bundled into the CLI, measured by `scripts/measure-load.ts` (`measure.ts`) from this machine's records.
Default range: from the day every enabled account has sample lines to now. Measured 2026-11-19 over 2026-10-27 .. 2026-11-19
(2867 sample lines, 1174 picks, 3718 sessions):

| Number | Value | From |
|-|-|-|
| Session length | median 0.67 h, p75 1.8 h, p90 5.2 h, cut at p95 12.9 h | each transcript's first to last write (`<dir>/projects/*/*.jsonl`); a transcript resumed days later is not one running session, hence the cut |
| Burn per running session | 0.0022 Max-weeks per hour | weekly units consumed / session hours |
| Weekly points per 5 h point | Max 0.156 (the sim guessed 0.125); Ultra none | consecutive sample lines inside one 5 h window and one week |
| Demand | 1.16 of the pool's weekly capacity | weekly units consumed per week (a week's running maximum, so feeds that disagree by a point never count twice); a floor, since walls cut the rest |
| Demand curve | 0.42 at 05 UTC to 1.48 at 17 UTC; Sunday 0.76, Monday 1.17 | the consumption spread over the hours between sample lines (at most 6 h back) |
| Lane mix | interactive 14 %, homeless (`lead`, `fan`, the factory's usage lane, agent-gateway lanes) 86 %, `bulk` and `headless` 0 | picks.jsonl lanes classed against the registry |

The pick log holds only the spawns that called `claude-account pick` (since 2026-11-05 mostly interactive and `lead`): the factory's
own account choice does not write it, so the mix is the best the log can tell, not the whole load.

### Compare and the verdict

`compare` runs every policy over demand 0.85, 0.9, 1.0, 1.1, 1.2 and pools of 1, 2, 3, 5 and 8 accounts of mixed plans (`mixedPool`:
an Ultra with the interactive and headless lanes, then Max (`bulk`) and Ultra accounts with staggered resets, the first three at
this machine's offsets), 3 weeks each, 10 seeds per cell, judged on the resets after the first week. A candidate **beats v1.9**
with all three of: more capacity-weighted quota used at reset, the mean paired difference (same pool, demand and seed) above two
standard errors; no more moved sessions over the grid; and no more work blocked than v1.9 in any cell at demand 1.0 or below. The
last is "nothing blocked" read against the pool: a single account blocks about 1 % at demand 1.0 under every policy (with one
account there is no choice to make), so the candidate is held to blocking nothing that v1.9 does not.

**Finding (2026-11-19, the model above): no candidate beats v1.9, which stays live.**

| Candidate | Used at reset (v1.9 94.45 %) | Paired gain | Moved sessions (v1.9 73245) | Blocked at <= 1.0 |
|-|-|-|-|-|
| `laxity` | 94.37 % | −0.08 ± 0.09 points | 67836 (−7 %) | as v1.9 |
| `laxity-pure` | 93.68 % | −0.77 ± 0.13 points | 26494 (−64 %) | as v1.9 |
| `v1.9-cool` | 94.32 % | −0.13 ± 0.11 points | 48574 (−34 %) | as v1.9 |

Why: on the measured load the pool runs at its wall (demand 1.16) and v1.9 already ends nearly every week at 96-100 % from
demand 1.0 up; below 1.0 the slack must land somewhere, and where it lands changes the capacity-weighted total by less than the
seed noise. Laxity's due step answers a fifth to a quarter of the picks at demand 1.0 (3 to 8 accounts), but it changes the
order in which accounts fill, not how full they end: a Max at 0.156 per 5 h point needs about 32 h of full windows, well inside the
72 h horizon that already serves the soonest reset. Without the fixed horizon
(`laxity-pure`) the due step starts an account only when it can just barely fill, so a dip in demand leaves it short: less
quota used, though far fewer sessions moved (the 72 h step piles bulk work on one Max until its 5 h window walls). `v1.9-cool`
keeps v1.9's use within the noise and moves a third fewer sessions; it loses only on the "more used" count. The shadow log records
how often each would have picked otherwise, so the next round has live disagreement beside the simulation.

## The factory server

The factory server reads the accounts through this package, in its own process (`apps/server/src/adapters/planning/accounts-source.ts`):
no `claude-account` call, no copy of the rule, no registry setting of its own (the paths above decide; `CLAUDE_ACCOUNTS_REGISTRY`
moves them). The package stays independent of the server: `claude-account` works with the server down and on a machine without a checkout.

| Library call (`src/read.ts`) | What the server does with it |
|-|-|
| `readStatus({ nowMs, paths, history })` | `status --json` as a value. Each poll stores, per account, the windows beside the lane verdict for `bulk`: open, place, reason, why not, when it opens; `GET /v1/accounts` returns it whole |
| `wallResetAt(row, nowMs)` (`status.ts`) | the reset of the window nearest its ceiling when within 10 points of it: what a lead that ran into a wall waits for |
| `setModeOverride` / `clearModeOverride` | `POST` and `DELETE /v1/accounts/:id/mode`, the owner's (`factory accounts mode <id> <mode> [--until <iso|reset>] [--for <model>] [--why <text>]`); written to the override file, so `claude-account mode` sees it |
| `readQuotaAtReset({ weeks })` / `quotaUsedAtReset` (`history.ts`) | the KPI `quota_at_reset`: per week, the capacity-weighted mean of the weekly percent each account stood at when its weekly window reset, from the reset ledger |

What stays the server's: the allowance per account, one new lead per quota sample on an account whose 5-hour window is above 70 %,
the age (10 minutes) after which a reading admits nothing, the 401 mark of an account, and moving a walled lead.

## Installing

- **On the mini** the deploy (`make deploy`) links `~/.local/bin/claude-account-next` to the release's `packages/accounts/bin/claude-account.ts`
  beside the live `claude-account`, which it never touches (a regular file at that path is left alone). `make rollback`
  re-links it. The release holds the dependencies, so the entry runs as it is.
- **Without the factory** (the MacBook has no checkout): the deploy builds one file beside the CLI entry, `<release>/packages/accounts/dist/claude-account` (`make accounts-bundle`, `ACCOUNTS_OUT=<path>`,
  builds it from a checkout), that runs with bun alone: no checkout, no `node_modules`, the commit baked in. Copy it to `~/.local/bin/claude-account`.
  The package has no runtime dependency outside itself, so the file runs with bun alone; from an empty directory it answers `--version` and `usage --json` (`test/bundle.test.ts`).
- `--version` names the commit from the build, else from the `releases/<sha>/` directory it runs in, else from the checkout.

## Tests and parity

`bun test packages/accounts`: the ported unit tests of the dotfiles picker (rule, cache files, refresh, login expiry, the CLI against fakes), the
three-week simulation on the guessed load (`sim.test.ts`: it fails when a rule change wastes quota), the policy lab on the measured
one (`lab.test.ts`: the load model's shape and its measurement, laxity, the verdict rule, the shadow log), the owner's adapters
against fakes and the bundle.
`test/parity.test.ts` runs one fixture registry, cache and clock through the dotfiles CLI and this one for every verb and lane
(257 cases, each stdout, exit code and, for a writing verb, the files it left): identical. Where the dotfiles checkout exists
it runs both; everywhere it holds the package to `test/fixtures/parity-golden.json`, what the dotfiles CLI printed
(`bun packages/accounts/scripts/record-golden.ts` records it from the dotfiles CLI, only for a deliberate change of the contract).

The package's `src` type-checks under the root `noUncheckedIndexedAccess` (the server's program imports it: a lookup of an id that must exist goes through `required`, which throws where the old code would have crashed); its own `tsconfig.json` keeps the flag off for `test/` and `scripts/`, and `make check` runs both.

## Left out on purpose

The spawn integration (`c`, `rd`, `cf`), the keepalive and heartbeat jobs, the statusline hook, the login logistics and the
attribution of usage stay in dotfiles and call these verbs; the switch row moves them. No new rule, window or account setting
was added by the port (`subs-package`); registry v2 and the modes came with `subs-model-v2` (§Modes). The history, the forecast and the status verb came with `subs-read-model` (§History, §status); the server reads the accounts in-process from `src/read.ts` since `subs-server` (§The factory server), and the Console reads them through the server's `GET /v1/accounts`. The policy lab (`subs-policy-lab`) added policies, the measured load model, `simulate`,
`compare` and the shadow log; it does not re-measure the model on a schedule (`measure-load.ts` by hand, and the file is
committed) and judges no policy on live outcomes, which need weeks of a policy actually live. Onboarding (`subs-onboard`) does not run the login itself (it is a browser the user signs in with: `add` prints the command) and
does not delete anything on `remove`; a peer needs no more than ssh and its own `claude-account`, there is no sync service.
