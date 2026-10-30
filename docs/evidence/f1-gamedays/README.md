# F1 gamedays: a killed server and a restored database, 2026-10-30

**Verdicts.**

| Gameday (`docs/design.md` §13) | Verdict |
|-|-|
| The server is killed mid-spawn and while sessions work | **Pass.** Five `kill -9` of the live server (three moments, two of them more than once): each time the LaunchAgent had it healthy again in under a second, the session kept working, the spawn was reconciled onto its own tab and agent, and there was one tab, one agent and one first prompt per key. One cost: a kill inside a start leaves the spawn `starting` for 4 minutes (the claim lease) before it is reconciled |
| The database restored from last night's dump | **Fail, in part.** Running panes are found again and no second tab, agent or first prompt appears for them; no identifier outside the database comes from a database sequence, so there is nothing to move past. But the restored server does two things twice (it starts a spawn that already ran and finished, and it types a wake note that was already delivered), and it cannot recover what lived only in the database or in a rotated spool file. No fix was made: each needs a decision (below). Pinned as three expected failures in `packages/server/test/restore.test.ts` |

## 1. The server killed (live, `scripts/gameday/`)

Live factory at release `dd9b001e2023` (the deployed one; this branch only adds tests, scripts and evidence), real herdr, real
Claude Code sessions (role `worker`, Sonnet) in a scratch repo with a local bare remote (`setup.sh`). Each session is told to run
a 50 s `perl` sleep, write one file, commit it, push and end its turn, so a turn is long enough to be killed inside. Other
sessions on the host (`factory status` before and after lists the same ones working) kept working and were not touched.

What is killed: only the factory's own `bun packages/server/src/main.ts`, the child of the LaunchAgent's job, checked by command line
and by working directory (a release) in `kill-server.sh`. Nothing else. The restart is the LaunchAgent's own `KeepAlive`, not
`make deploy`. The kill is placed by what the server is doing, not by a delay: `when-child.sh` waits for a child process of the server
(the server calls herdr as child processes) and kills the moment it appears; `when-working.sh` waits for the session to be `working`.

| Run | Moment | What the kill hit | Server healthy again | Spawn reconciled | Checks |
|-|-|-|-|-|-|
| `fgd-g1-claimed` | after the claim, before the Runner returns | `herdr agent start` running: tab `w71:t1` exists, agent not ready | 878 ms | 20:17:30, **4 min 4 s** after the kill, `attempts=2`, same pane `w71:p1` | 9 of 10, see "First attempt" |
| `fgd-g2-claimed` | the same | `herdr agent start` running, tab `w71:t2` | 865 ms | 20:23:55, **4 min 3 s**, `attempts=2`, same pane `w71:p2` | 10 of 10 |
| `fgd-g2-prompt` | agent up, first prompt being submitted | `herdr agent prompt` running; herdr said `idle` the instant after | 922 ms | 20:31:26, **4 min 8 s**, `attempts=2`, pane `w71:p3` | 10 of 10 |
| `fgd-g2-working` | a turn in progress | no child; herdr `working` | 732 ms | not needed: the spawn was already `started` (`attempts=1`) | 10 of 10 |
| `fgd-g3-working` | a turn in progress, run with the hardened scripts | no child; herdr `working` | 829 ms | 20:48:09, **4 min 0 s** after the kill: the session's first hook had already made it `working`, but the server had not yet recorded the Runner's result, so the row was still `starting`; `attempts=2`, same pane `w72:p1` | 9 of 10 by the script, 10 of 10 counted by hand, see "Third working run" |

Times are in `kills.txt` (the kill and the restart) and each run's `timeline.txt` (the spawn and session as `factory spawn get` /
`session get` showed them every 3 s, changes only).

### The checks (`collect.sh`, per run, `result.txt`)

Counted after the turn ended, from three sources that do not share a failure: herdr's listing, the factory's own rows, and
Claude Code's transcript.

| Check | Expected | Every run |
|-|-|-|
| Tabs in herdr labelled with the key | 1 | 1 |
| Agents in that tab's pane | 1 | 1 |
| `spawn get`: status, and its pane is the tab's pane | `started`, equal | yes |
| `session_started` events | 1 | 1 |
| User messages carrying the prompt marker in the transcript (the authoritative count of first prompts) | 1 | 1 |
| `turn_started` events | 1 | 1 (g1: 2, see below) |
| Rows in `prompts` for the session (the first prompt is the Runner's, not a row) | 0 | 0 |
| Commits for the key on the scratch remote | 1 | 1 |

### What each kill shows

- **Claimed** (`herdr agent start` in flight). The spawn row is `starting`, the tab exists, the orphaned `herdr agent start` finishes
  on its own and leaves a ready agent with no prompt. No tick records a result. After the claim lease (`DEFAULT_LEASE_MS` = start
  budget 180 s + 60 s) the next tick reclaims the row, the Runner finds the tab by label and the agent by pane, sees a fresh idle
  agent, types the prompt once, and the row becomes `started` on the same pane with `attempts=2`. No second tab, no second agent.
- **Prompt** (`herdr agent prompt` in flight). The prompt reached the agent: `turn_started:1` is stamped 20:27:17.645, 129 ms *after*
  the kill and before the server was healthy again (20:27:18.487), so the hook's own post had no live server to land on (it is
  stored once either way: the spool replay or a post to the new server; which of the two cannot be told from the row).
  The row stayed `starting` until the lease (20:31:21 reclaimed, 20:31:26 `started`), while the session had already finished its turn
  (idle since 20:28:13). The reclaim found an agent that had taken its prompt (`done`/`working`) and typed nothing: one user message
  in the transcript, no second turn.
- **Working.** The spawn was `started`, the session `working`; the restart touched neither. `turn_ended:1` 20:33:30.5 arrived through the
  new server, the commit is on the remote.

### Third working run (`fgd-g3-working`), after the review

Made with the scripts as hardened after review (the kill pattern names the key, a trap disarms the watcher, the exit status reports
failed checks, kill logs show no child arguments, the user name is scrubbed). It landed in a third state the first two did not: the
session had sent its first hook (so `session get` says `working` and `when-working.sh` fires) while the spawn row was still
`starting`, because the Runner had not returned yet. Reconciliation was the same as for `claimed`: the claim lease (4 min 0 s), then
the Runner found the tab and an agent that had taken its prompt and recorded `started` on pane `w72:p1`, with no second prompt.

The script reports one failure there, `user messages carrying the prompt` 0, and it is the script's: scrubbing the user name also
rewrote the transcript path that `collect.sh` then tried to open. Fixed (the path is read from the unscrubbed answer); counted by hand
on the real transcript afterwards: **1**. The run's `result.txt` is left as the script wrote it.

### First attempt (`fgd-g1-claimed`), kept

Nine of ten: `turn_started` is 2, not 1. That is my script's expectation, not the factory: the prompt told the agent to run a plain
`sleep 50`, Claude Code's harness blocked it and the agent ran it in the background; the background command's completion woke the
session for a second turn (20:18:22) with no prompt typed by anyone (transcript user messages carrying the prompt: 1; `prompts`
rows: 0). The prompt now uses `perl -e 'sleep 50'`, which is not blocked, and `run.sh` no longer waits for `turn=1`.

### Not proven

- **No hook fired inside a longer outage.** The LaunchAgent restarts the server in under a second, so the live window in which a hook
  finds no socket is a few hundred ms (it did happen once, the `turn_started:1` above). The longer-outage spool replay is covered by
  the tests (`spool.test.ts`), not by this run. A multi-minute outage would need `launchctl bootout`, which is a deploy-style stop and
  was not done here.
- **The gap between `tab create` and `agent start`** (the pretrust call) was not targeted live: a tab with no agent at all, which the
  Runner closes and makes again. That path is `runner.test.ts`'s.

### Operator notes

- `kill-server.sh` writes the epoch line `deploy.sh` writes before a deliberate restart (`~/.local/state/devhost/deliberate-restart/`),
  so the dotfiles heartbeat does not page for it.
- The stop hook's send-back fired on my own session during the runs ("2 workers still running"): the `fgd-*` spawns were my children
  (`factory spawn create` defaults `--parent` to `FACTORY_SESSION`). I declared `factory session wait --on workers`, and the wake rule
  typed `workers done: fgd-g1-claimed idle, fgd-g2-claimed idle` between two runs, when no spawn of the next run existed yet. That is the
  rule's documented behaviour ("a spawn that has no session yet is not finished" only counts spawns that exist).
- Raw: `kills.txt`, `server-out-tail.txt` (the server's log across the restarts: one `listening` line per restart, `errors: []` in every
  tick), `server-err-kills.txt` (the shell's `Killed: 9` for each killed pid), and per run `events.txt`, `spawn-row.txt`,
  `spawn.json`, `session.json`, `herdr-tabs.json`, `herdr-agents.json`, `pane-tail.txt`, `prompts.txt`, `kill.out`.
- Scratch repo, bare remote and the five tabs removed with `teardown.sh`. The five spawn rows stay in `factory.spawns` for good
  (keys `fgd-g1-claimed`, `fgd-g2-claimed`, `fgd-g2-prompt`, `fgd-g2-working`, `fgd-g3-working`). The `g1` and `g2` runs
  used the scripts before the review fixes (the watcher pattern did not name the key; nothing else on the host started an agent in
  those minutes, which `kills.txt`'s child lines show).

## 2. The database restored from an earlier dump (a test, `packages/server/test/restore.test.ts`)

Never against the live database and never a second server on the real panes: a private Postgres cluster (the harness'), the fake
herdr, a temporary spool directory. `pg_dump --schema=factory` is taken at one moment, the dump is restored with `psql` into a
database of its own, a new server (new pool, new spool reader with no offsets, new runner) starts on it against the *same* herdr and
the *same* spool, as a restart on a restored database would.

The world, with the dump in the middle:

| | Before the dump | After the dump |
|-|-|-|
| `a` | spawned, working | another turn |
| `o`, `k1` | `o` orchestrates `k1` and declares `wait --on workers`; `k1` works | `k1` finishes; the wake rule records and types `wake:o:…`; `o` takes it, clears its wait (`--done`), ends its turn |
| `c` | spawn row `queued`, not started | started, works, ends, its tab is closed |
| `b` | does not exist | spawned and working; its row is not in the dump |

### Passes

- The panes that were running (`a`, `o`, `k1`, `b`) have one tab, one agent and one first prompt each after the restore and three
  passes; their tab ids are the ones they had; no extra herdr space.
- A client that asks again for `b` (its row is gone, the pane is not) gets a new row, and the Runner finds the tab by label and the agent
  already working: no second tab, no second prompt.
- The spool brings the sessions back: `a` working, `b` working, `c` dead, `k1` idle. A second replay (another restart) stores nothing.
- **Ids.** "Ids move past running panes" has no work to do: nothing outside the database is built from a database sequence. The only
  sequences are the `bigserial` primary keys of `events`, `quota_readings` and `capacity_readings`, which are never written into a
  pane, a prompt, a key or a label. Event keys are session, kind and turn counted from the spool; tab labels are spawn keys (herdr's
  pane and tab ids are herdr's own); prompt ids are a rule's key (`resume|rotate|blocked|wake|restart:…`) or `note:<uuid>`; wait events
  are `<session>:wait_*:<uuid>`. The one counter derived from database state is the witness' `pane_gone` key
  (`<session>:pane_gone:<starts>:<gones+1>`), which only counts events that are themselves in the database, so a restore can reissue a key
  only for an event it also lost.

### Fails, and why no fix was made

1. **A spawn that ran and finished after the dump is started again.** `c` is `queued` in the dump; it ran, ended and its tab was
   closed. The restored row says `queued`, so the tick claims it and the Runner makes a new tab and types the prompt: duplicate work
   in a repo that already has the result. The spool has the evidence (the session lived and ended), the tick does not look. A fix
   cannot be "skip a spawn whose key has events": `factory spawn requeue` and a retry whose agent started before its record was
   written both have a row in a not-started status and events. Telling a stale row from a deliberate one needs a decision about what
   a spawn row is when the database is older than the world (for example reconciling spawn rows from the sessions the spool proves
   before the first claim, or recording the requeue as an event). Test:
   `a spawn that ran and finished after the dump is not started again from its stale queued row` (`test.failing`).
2. **A delivered wake note is typed again.** After the dump `o` was woken, took the note and cleared its wait. The clearing
   (`wait_cleared`, written by `factory session wait --done` straight to the database, never to the spool) and the note's row are both
   after the dump, so the restored database has the wait open, `k1` done and no `wake:o:<wait event>` row: the rule records it again and
   the Runner types it into `o` a second time (`o` has the first prompt and two identical wake notes). The same shape holds for any rule
   whose "already done" lives only in a row after the dump. Changing the derivation (a later `turn_started` ends a wait) changes what
   `waiting` means for the orchestrators the design depends on, so it is not a small change. Test:
   `a wake note that was typed and delivered after the dump is not typed again` (`test.failing`).
3. **Not everything is in the spool.** Waits (`wait_declared`, `wait_cleared`), notes, rows of `spawns` created after the dump, queue
   states, effects and the witness' events exist only in the database. And the spool is not a log: a quiet file over 64 KiB is rotated,
   its lines stored and the file deleted, so events that came after the dump and were rotated away are gone from both. Test (pinned
   as expected to fail, it documents a loss rather than a bug): `events of a rotated spool file that came after the dump are gone for good`.
   A restore should therefore be followed by an owner pass over `factory status`, not trusted as is; the numbers above say what is
   recoverable (every session's state from its spool, every running pane from herdr) and what is not.

`test.failing` keeps `make check` green while each gap is documented; when a fix lands the test turns red and the `.failing` comes off.

## What broke and what was fixed

Nothing in `packages/**` was changed: the kill gameday found nothing to fix, and the restore gameday found three gaps whose fixes are
decisions (above), not small changes. The commits are the restore test, the gameday scripts and this evidence.
