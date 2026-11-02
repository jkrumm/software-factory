# F2 gameday: a silent lead, run s2: PASS

- Gameday silent-lead; Issue 34, lead session `lead-34-1`
- Lead: sonnet medium on me2
- Wall time: 2m36s (setup to teardown)

## Pass conditions

| Verdict | Line | Expected | Got |
|-|-|-|-|
| PASS | the Issue reached waiting/unreported on its own | 1 | 1 |
| PASS | Issue state after the second stop | waiting/unreported | waiting/unreported |
| PASS | the lead's first prompt is the brief, a delivered prompt row (the turn that was sent back) | issue:34:brief:1|brief|delivered | issue:34:brief:1|brief|delivered |
| PASS | send-back effects (issue-sendback:<session>:<turn>) | 1 | 1 |
| PASS | the send-back is of the brief's turn (turn 1) | 1 | 1 |
| PASS | unreported inbox rows, applied | 1|applied | 1|applied |
| PASS | the unreported row is of the same turn as the send-back | unreported:34:lead-34-1:1 | unreported:34:lead-34-1:1 |
| PASS | notify:parked rows in factory.notifications | 1 | 1 |
| PASS | the claim repo:factory-gameday-silent is held while the Issue is parked | repo:factory-gameday-silent|true | repo:factory-gameday-silent|true |
| PASS | the lead's session is still alive | yes | yes |
| PASS | no lead verb reached the inbox | 0 | 0 |
| PASS | issue_events kinds: nothing besides the path to parked | created,classified,admitted,unreported | created,classified,admitted,unreported |
| PASS | prompts typed to the lead (the brief alone) | 1 | 1 |
| PASS | evidence rows | 0 | 0 |
| PASS | commits the lead added on the remote | 0 | 0 |
| PASS | the lead's worktree exists while parked | yes | yes |
| PASS | Issue after stop: closed/dropped | closed|dropped | closed|dropped |
| PASS | finalize ran once (issue_finalized events) | 1 | 1 |
| PASS | claim rows after finalize | 0 | 0 |
| PASS | live terminals of the lead after finalize (tab closed) | 0 | 0 |
| PASS | the lead's worktree directory after finalize | no | no |
| PASS | the lead's branch factory/34-1 after finalize | gone | gone |
| PASS | transcripts archived for the attempt (not a pass line of the brief) | at least 1 | 1 |

## Notes

- owner's line: sent - Issue 34 (factory-gameday-silent) parked: its lead stopped twice with nothing reported
- finalize reached: 1; the server's tick errors since the run began are not read here

## Timeline

The run script's own log is `timeline.txt`. The machine: `issue_events` (time, kind, from, to, key, payload).

```
05:13:28.752|created||queued|created:34|{"source": "request"}
05:13:36.413|classified|||classified:34|{"kind": "chore", "size": "s", "tier": "sonnet", "class": "routine", "effort": "medium", "clamped": false, "floored": false}
05:13:41.425|admitted|queued|working|admit:34:1|
05:14:01.037|unreported|working|waiting|unreported:34:lead-34-1:1|{"turn": 1}
05:15:42.560|stop|waiting|closed|stop:34:gd-s2|{"reason": "gameday done"}
05:15:47.156|issue_finalized|||issue_finalized:34:1|{"attempt": 1}
```

The inbox (time, kind, session, result, detail, key):

```
05:13:41.425|admitted||applied||admit:34:1
05:13:57.087|session_started|lead-34-1|ignored||lead-34-1:session_started:0
05:13:57.487|turn_started|lead-34-1|ignored||lead-34-1:turn_started:1
05:14:01.037|unreported|lead-34-1|applied||unreported:34:lead-34-1:1
05:14:01.056|turn_ended|lead-34-1|ignored||lead-34-1:turn_ended:1
05:15:01.095|prompt_idle|lead-34-1|ignored||lead-34-1:prompt_idle:1
05:15:42.560|stop||applied||stop:34:gd-s2
05:15:46.623|session_ended|lead-34-1|ignored||lead-34-1:session_ended:1
```

Session events of the lead (time, kind, session, key):

```
05:13:57.087|session_started|lead-34-1|lead-34-1:session_started:0
05:13:57.487|turn_started|lead-34-1|lead-34-1:turn_started:1
05:14:01.056|turn_ended|lead-34-1|lead-34-1:turn_ended:1
05:15:01.095|prompt_idle|lead-34-1|lead-34-1:prompt_idle:1
05:15:46.623|session_ended|lead-34-1|lead-34-1:session_ended:1
```

Notifications (time, key, kind, status, text):

```
05:14:01|notify:parked:34:2|parked|sent|Issue 34 (factory-gameday-silent) parked: its lead stopped twice with nothing reported
```
