# F2 gameday: a bug only production shows, run b3: PASS

- Gameday seeded-bug; Issue 37, lead session `lead-37-1`
- Lead: sonnet medium on iu
- Wall time: 2m26s (setup to teardown)

## Pass conditions

| Verdict | Line | Expected | Got |
|-|-|-|-|
| PASS | the Issue ran to its close without the owner (not stuck, not idle) | 1 | 1 |
| PASS | Issue after the run: closed/done, attempt 1 | closed\|done\|1 | closed\|done\|1 |
| PASS | ships (watching entered) | at least 1 | 1 |
| PASS | evidence rows by the lead (not the factory) before the first ship | at least 1 | 3 |
| PASS | the Issue was watching (hold_over events) | at least 1 | 1 |
| PASS | ships | 1 | 1 |
| PASS | verified holds | verified:37:1 | verified:37:1 |
| PASS | tool results in the lead's transcript with the deployed copy's verify failure (only the real output has this text) | at least 1 | 10 |
| PASS | production now: the deployed copy's self test | selftest: ok words=9 lines=2 | selftest: ok words=9 lines=2 |
| PASS | the change is on origin/master (--longest in bin/wordstat) | yes | yes |
| PASS | finalize ran once (issue_finalized events) | 1 | 1 |
| PASS | claim rows after finalize | 0 | 0 |
| PASS | live terminals of the lead after finalize (tab closed) | 0 | 0 |
| PASS | the lead's worktree directory after finalize | no | no |
| PASS | transcripts in the archive for the attempt | at least 1 | 1 |
| PASS | evidence rows of kind transcript | at least 1 | 1 |

## Notes

- no regression: the bug has to have bitten the lead's own production check before the ship, or the gameday did not happen

## Timeline

The run script's own log is `timeline.txt`. The machine: `issue_events` (time, kind, from, to, key, payload).

```
05:20:34.966|created||queued|created:37|{"source": "request"}
05:20:38.797|classified|||classified:37|{"kind": "feature", "size": "s", "tier": "sonnet", "class": "routine", "effort": "medium", "clamped": false, "floored": false}
05:20:41.563|admitted|queued|working|admit:37:1|
05:21:00.006|phase|working||37:1:phase:f73bda7e-1cf8-493f-8946-77266795ac2e|{"phase": "investigate", "attempt": 1}
05:21:21.515|refused|working||37:1:ship:d8fa1f20-4e59-46ab-b773-b2054e8652f9|{"event": "ship", "detail": "ship refused, evidence missing recorded after the merged commit (2026-11-02T05:21:17.000Z): infra (the service's status and logs after the change). File each with `factory issue evidence 37 --kind <kind> --link 
05:21:26.335|ship|working|watching|37:1:ship:83e3f450-7295-4ec6-9f20-e93217ca00f4|{"attempt": 1, "commits": ["b24b6f3e6ab5e6217e6dc33a2b624564bf1be281", "43a2ee1df2daa1327719b2e12f9ebf4d8fdab62b"], "derived": {"paths": ["bin/wordstat", "deploy/limits.conf", "test/run.sh"], "holdMs": 60000, "commits": ["b24b6f3e6ab5e6217e
05:22:31.575|hold_over|watching||hold:37:1:1|{"hold": 1}
05:22:31.700|verified|watching|closed|verified:37:1|{"hold": 1, "checks": [{"ok": true, "name": "make verify", "detail": "exit 0: verify: ok 43a2ee1df2daa1327719b2e12f9ebf4d8fdab62b (selftest: ok words=9 lines=2)"}]}
05:22:37.306|issue_finalized|||issue_finalized:37:1|{"attempt": 1}
```

The inbox (time, kind, session, result, detail, key):

```
05:20:41.563|admitted||applied||admit:37:1
05:20:57.737|session_started|lead-37-1|ignored||lead-37-1:session_started:0
05:20:57.840|turn_started|lead-37-1|ignored||lead-37-1:turn_started:1
05:21:00.006|phase|lead-37-1|applied||37:1:phase:f73bda7e-1cf8-493f-8946-77266795ac2e
05:21:21.515|ship|lead-37-1|refused|ship refused, evidence missing recorded after the merged commit (2026-11-02T05:21:17.000Z): infra (the service's status and logs after the change). File each with `factory issue evidence 37 --kind <kind> --link <url>`, then ship again.|37:1:ship:d8fa1f20-4e59-46ab-b773-b2054e8652f9
05:21:26.335|ship|lead-37-1|applied||37:1:ship:83e3f450-7295-4ec6-9f20-e93217ca00f4
05:21:35.004|turn_ended|lead-37-1|ignored||lead-37-1:turn_ended:1
05:22:31.575|hold_over||applied||hold:37:1:1
05:22:31.700|verified||applied||verified:37:1
05:22:35.041|prompt_idle|lead-37-1|ignored||lead-37-1:prompt_idle:1
05:22:36.761|session_ended|lead-37-1|ignored||lead-37-1:session_ended:1
```

Session events of the lead (time, kind, session, key):

```
05:20:57.737|session_started|lead-37-1|lead-37-1:session_started:0
05:20:57.840|turn_started|lead-37-1|lead-37-1:turn_started:1
05:21:35.004|turn_ended|lead-37-1|lead-37-1:turn_ended:1
05:22:35.041|prompt_idle|lead-37-1|lead-37-1:prompt_idle:1
05:22:36.761|session_ended|lead-37-1|lead-37-1:session_ended:1
```

Notifications (time, key, kind, status, text):

```
```
