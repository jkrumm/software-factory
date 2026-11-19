# Claude Code subscriptions: the account picker

`packages/accounts` is the picker for N Claude Code subscriptions as a library and as the `claude-account` CLI: a registry of
accounts, a per-account quota cache, the rule that says which account a new session starts on (rule v1.9, Fable and drain
mode), and the logins' health. It is the port of the dotfiles picker (program "subscriptions", `docs/plan.yaml` row
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
| Quota cache | `~/.cache/claude-accounts/` (`$CLAUDE_ACCOUNTS_CACHE_DIR`): `<id>.sample.json`, `.exhausted.json`, `.auth.json`, `.verified.json`, `.statusline.json`, `.refresh.claim`, `.relogin-ask.json` |
| Pick log | `~/.local/share/claude-accounts/picks.jsonl` (`$CLAUDE_ACCOUNTS_PICKS`); usage tracker, the browser extension and the dashboards read it |
| Keepalive log | `~/Library/Logs/claude-accounts-keepalive.log`: the stdio of the keepalive job and of the detached refresh a pick spawns |
| Test seam | `$CLAUDE_ACCOUNTS_SECURITY_BIN` replaces `/usr/bin/security` |

## The registry

```json
{
  "fable": null,
  "drain": [],
  "accounts": {
    "main": { "dir": null, "plan": "ultra", "homeLanes": ["interactive", "headless"], "enabled": true },
    "bulk": { "dir": "~/.claude-bulk", "plan": "max", "homeLanes": ["bulk"], "units": { "session": 1, "weekly": 1 }, "loginBrowser": "Google Chrome", "enabled": true }
  },
  "integrations": {}
}
```

- `dir: null` is the account of the default `~/.claude` (`CLAUDE_CONFIG_DIR` unset); exactly one account must own it, and a dir
  set to `~/.claude` explicitly would change the Keychain service and look logged out. Any other dir is that account's config
  dir; its login lives in the Keychain item `Claude Code-credentials-<first 8 hex of sha256(abs dir)>`.
- `plan`: `max` (5 h session window and weekly) or `ultra` (weekly only); the legacy `max5x`/`max20x` read as `max` with units by multiple.
  `units` default from the plan (ultra 4 / 2, max 1 / 1).
- `homeLanes`: the lanes whose spawns start here; an exact lane name wins over a `prefix:*` wildcard. `loginBrowser`: the app a
  re-login opens (data for the relogin command). `enabled: false` ships an account dark until its login exists.
- `fable`, `drain`: §Fable mode, §Drain mode. Unknown top-level keys are ignored, so a registry shared with the dotfiles CLI is valid.
- The ids are letters, digits, `_` and `-` (they name cache files); `spill` is reserved.

## Layout of the package

| Module | What it holds |
|-|-|
| `policy.ts` | The pure rule: types, `pick`, `rank`, `eligible`, `accountWeight`, the sample merge and parsers, login grades, `dueIds`, `reloginCandidates`. No file, process, network or clock access (`test/policy-pure.test.ts` fails on one); the clock and the random source are arguments |
| `health.ts` | Pure grading of one machine's `usage` and `expiry` into health rows |
| `registry.ts`, `paths.ts`, `store.ts` | The registry file, every path, the per-account cache files and the claim and stamp files |
| `ports.ts` | The ports: `Spawner`, `HttpGet`, `PeerUsage` |
| `keychain.ts`, `oauth.ts`, `claude-auth.ts`, `spawn.ts` | The adapters: the login item through `security`, the usage endpoint, `claude auth status`, processes with a deadline that returns |
| `refresh.ts`, `relogin.ts` | The orchestration over the ports: claim, sample, record; the re-login asks |
| `integrations.ts`, `peers.ts` | The configurable adapters (§Integrations) and the health reads of a machine |
| `cli.ts`, `bin/claude-account.ts` | The verbs; the entry |

## Integrations

What was code for one owner's machines is a command in configuration, so a user without a peer machine or a dialog tool omits
it and loses only that feature. The registry's `integrations` object is overlaid key by key with the per-machine file
`$CLAUDE_ACCOUNTS_INTEGRATIONS`, else `~/.config/claude-accounts/integrations.json` when it exists (the registry is shared by
machines; the commands that reach a peer are not). A command is an argv, never a shell string; `{id}`, `{reason}`, `{machine}` and
`{message}` in an element are replaced. A malformed object is one stderr line and switches off the features it configures; `pick`
never reads it.

| Key | Command | Used by |
|-|-|-|
| `peerUsage` | prints the peer machine's `claude-account usage --json` | `refresh`: the peer's samples are imported once per run (§Quota sources, 4) |
| `reloginAsk` | started detached with `{id}` and `{reason}`: a dialog asking its owner for a re-login | `refresh --all`: a dead login or one inside its last 7 days asks once per 24 h per account and once per hour per machine, never an auto-run. Absent: nothing is read or stamped |
| `health.local` | this machine's name in the rows (default: the host name) | `health` |
| `health.pending` | prints this machine's pending re-login asks, one `<id> <epoch s>` per line | `health` |
| `health.fix` | the repair command shown on a row, with `{id}` and `{machine}` | `health` |
| `health.peer` | `{ name, snapshots: [{ via, argv, note? }], repush? }`: the peer is read through the first snapshot whose stdout is `<usage --json> @@ <expiry --json> @@ <pending asks>`; its `note` is printed when it answered or was the last tried; `repush` runs per pending ask younger than 24 h on `--wake` | `health` |
| `health.notify` | started once per change of the picture on `health --wake`, with `{message}` | `health --wake` |

```json
{ "peerUsage": ["ssh", "-o", "BatchMode=yes", "<peer>", "claude-account", "usage", "--json"],
  "reloginAsk": ["bash", "<path>/relogin.sh", "{id}", "--ask", "--reason", "{reason}"] }
```

## Quota sources

**Quota sources: read-only use of the account's own token for one GET, plus a peer import.** Four feeds, freshest wins, all
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
   (`src: oauth`). Any failure (Keychain locked or denied, HTTP 401/429/5xx, unparseable body) means *no sample* and
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
   --json` once (the command `integrations.peerUsage` names, 20 s cap; §Integrations) and turns each row of a locally registered, enabled account into a sample (`src: peer`).
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
claude-account pick --lane <lane>   # prints "export CLAUDE_CONFIG_DIR=…" or "unset CLAUDE_CONFIG_DIR"; no headroom: prints "spill", exit 3
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
  6. interactive → iu (Claude Code shows the limit itself)
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

## Fable mode

Fable resets refill only Fable usage, so one account is set aside for Fable. The registry's top-level `"fable": "<id>"`
 does two things:

- `cf` launches on it (`claude-account fable` prints it; Fable mode off, the account disabled or the CLI failing → the
  default account). `cf --account <id>` still wins.
- every pick, any lane, runs the rule without it first; it takes work only when no other account is eligible (reason
  `fable-reserve`). `rank` therefore lists it last, so factory leads reach it last too. Its `homeLanes` stay as they are,
  so switching the mode off restores the plain rule.

Switch: set `"fable"` to another account id, or to `null` for off, and commit. Read on every call, no restart.

## Drain mode

The registry's top-level `"drain": ["<id>", …]` names accounts the owner wants at the wall fast (an account to empty before
a reset he controls, or a week he knows will go unused otherwise). Every pick, any lane, takes a drain account first while its
5h window is under `SESSION_SOFT_MAX` (reason `drain`; several share by weight); its weekly ceiling is 100, not 95/98. A hot
5h window hands the work to the plain rule until the window cools. A drain account cannot be the Fable account (`loadRegistry`
refuses it). Drain mode does not end by itself: remove the id once the account is full, or it keeps draining the next week.
With `"fable": "iu", "drain": ["me2"]` the order is me2 (drain), then me, then iu (fable-reserve) in every lane;
the simulation fills me2 within 3-4 hours and keeps iu under 65 % for the week.

## Installing

- **On the mini** the deploy (`make deploy`) links `~/.local/bin/claude-account-next` to the release's `packages/accounts/bin/claude-account.ts`
  beside the live `claude-account`, which it never touches (a regular file at that path is left alone). `make rollback`
  re-links it. The release holds the dependencies, so the entry runs as it is.
- **Without the factory** (a laptop): the deploy builds one file into the release, `<release>/dist/claude-account` (`make accounts-bundle`, `ACCOUNTS_OUT=<path>`,
  builds it from a checkout), that runs with bun alone: no checkout, no `node_modules`, the commit baked in. Copy it to `~/.local/bin/claude-account`.
  A machine with no peer, no dialog tool and no mini needs no `integrations` and works as it is.
- `--version` names the commit from the build, else from the `releases/<sha>/` directory it runs in, else from the checkout.

## Tests and parity

`bun test packages/accounts`: the ported unit tests of the dotfiles picker (rule, cache files, refresh, login expiry, the CLI against fakes), the
three-week simulation (`sim.test.ts`: it fails when a rule change wastes quota), the integrations and the bundle.
`test/parity.test.ts` runs one fixture registry, cache and clock through the dotfiles CLI and this one for every verb and lane
(257 cases, each stdout, exit code and, for a writing verb, the files it left): identical. Where the dotfiles checkout exists
it runs both; everywhere it holds the package to `test/fixtures/parity-golden.json`, what the dotfiles CLI printed
(`bun packages/accounts/scripts/record-golden.ts` records it from the dotfiles CLI, only for a deliberate change of the contract).

The package keeps the dotfiles code's index access rule: its own `tsconfig.json` leaves `noUncheckedIndexedAccess` off (the
picker indexes records by an id it has just checked) and the root typecheck excludes it; `make check` runs both.

## Left out on purpose

The spawn integration (`c`, `rd`, `cf`), the keepalive and heartbeat jobs, the statusline hook, the login logistics and the
attribution of usage stay in dotfiles and call these verbs; the switch row moves them. No new rule, window or account setting
is added here: the registry for N subscriptions with per-account modes is the next row.
