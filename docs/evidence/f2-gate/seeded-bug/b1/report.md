# F2 gameday: a bug only production shows, run b1: FAIL

- Gameday seeded-bug; Issue 35, lead session `lead-35-1`
- Lead: sonnet medium on me2
- Wall time: 2m12s (setup to teardown)

## Pass conditions

| Verdict | Line | Expected | Got |
|-|-|-|-|
| PASS | the Issue ran to its close without the owner (not stuck, not idle) | 1 | 1 |
| PASS | Issue after the run: closed/done, attempt 1 | closed\|done\|1 | closed\|done\|1 |
| PASS | ships (watching entered) | at least 1 | 1 |
| PASS | evidence rows by the lead (not the factory) before the first ship | at least 1 | 5 |
| PASS | the Issue was watching (hold_over events) | at least 1 | 1 |
| PASS | ships | 1 | 1 |
| PASS | verified holds | verified:35:1 | verified:35:1 |
| PASS | production now: the deployed copy's self test | selftest: ok words=9 lines=2 | selftest: ok words=9 lines=2 |
| PASS | the change is on origin/master (--longest in bin/wordstat) | yes | yes |
| PASS | the fix is on origin/master (MAX_WORDS no longer 3) | yes | yes |
| PASS | finalize ran once (issue_finalized events) | 1 | 1 |
| PASS | claim rows after finalize | 0 | 0 |
| PASS | live terminals of the lead after finalize (tab closed) | 0 | 0 |
| PASS | the lead's worktree directory after finalize | no | no |
| PASS | transcripts in the archive for the attempt | at least 1 | 1 |
| PASS | evidence rows of kind transcript | at least 1 | 1 |
| FAIL | the bug bit: a production check failed before the Issue closed (the lead's, or make verify after the hold) | 1 | 0 |
| FAIL | the bug bit: a production check failed before the Issue closed (the lead's, or make verify after the hold) | 1 | 0 |

## Notes

- FINDING, the seed was readable: the lead read deploy/limits.conf (MAX_WORDS=3 against a 9-word self test) and fixed it in its first commit, before any deploy. No production check failed and no regression happened, so neither pass path was exercised. The machine behaved (one ship, one hold, verified, one finalize, transcript archived); the seeded bug did not bite. Run b2 seeds a fault that a read does not show.

## Timeline

The run script's own log is `timeline.txt`. The machine: `issue_events` (time, kind, from, to, key, payload).

```
05:16:19.540|created||queued|created:35|{"source": "request"}
05:16:22.720|classified|||classified:35|{"kind": "feature", "size": "s", "tier": "sonnet", "class": "routine", "effort": "medium", "clamped": false, "floored": false}
05:16:26.470|admitted|queued|working|admit:35:1|
05:16:45.540|phase|working||35:1:phase:009889aa-ea96-461f-ac5f-5b68a3b47725|{"phase": "investigate", "attempt": 1}
05:16:58.308|phase|working||35:1:phase:cf6019e0-1cda-45de-bd44-b12ed2d4a3cc|{"phase": "production", "attempt": 1}
05:16:58.349|refused|working||35:1:ship:e0235863-1e87-48cf-82a3-510b1dd25716|{"event": "ship", "detail": "ship refused, evidence missing recorded after the merged commit (2026-11-02T05:16:55.000Z): infra (the service's status and logs after the change). File each with `factory issue evidence 35 --kind <kind> --link 
05:17:04.596|ship|working|watching|35:1:ship:62c2b96e-8f6b-4033-a3a0-153fc8658df0|{"attempt": 1, "commits": ["f99d778f5134c2f6113388ab8bd49fd7d3c4ba37"], "derived": {"paths": ["bin/wordstat", "deploy/limits.conf", "test/run.sh"], "holdMs": 60000, "commits": ["f99d778f5134c2f6113388ab8bd49fd7d3c4ba37"], "problem": null, "
05:18:06.497|hold_over|watching||hold:35:1:1|{"hold": 1}
05:18:06.614|verified|watching|closed|verified:35:1|{"hold": 1, "checks": [{"ok": true, "name": "make verify", "detail": "exit 0: verify: ok f99d778f5134c2f6113388ab8bd49fd7d3c4ba37 (selftest: ok words=9 lines=2)"}]}
05:18:12.247|issue_finalized|||issue_finalized:35:1|{"attempt": 1}
```

The inbox (time, kind, session, result, detail, key):

```
05:16:26.470|admitted||applied||admit:35:1
05:16:42.115|session_started|lead-35-1|ignored||lead-35-1:session_started:0
05:16:42.344|turn_started|lead-35-1|ignored||lead-35-1:turn_started:1
05:16:45.540|phase|lead-35-1|applied||35:1:phase:009889aa-ea96-461f-ac5f-5b68a3b47725
05:16:58.308|phase|lead-35-1|applied||35:1:phase:cf6019e0-1cda-45de-bd44-b12ed2d4a3cc
05:16:58.349|ship|lead-35-1|refused|ship refused, evidence missing recorded after the merged commit (2026-11-02T05:16:55.000Z): infra (the service's status and logs after the change). File each with `factory issue evidence 35 --kind <kind> --link <url>`, then ship again.|35:1:ship:e0235863-1e87-48cf-82a3-510b1dd25716
05:17:04.596|ship|lead-35-1|applied||35:1:ship:62c2b96e-8f6b-4033-a3a0-153fc8658df0
05:17:08.121|turn_ended|lead-35-1|ignored||lead-35-1:turn_ended:1
05:18:06.497|hold_over||applied||hold:35:1:1
05:18:06.614|verified||applied||verified:35:1
05:18:08.157|prompt_idle|lead-35-1|ignored||lead-35-1:prompt_idle:1
05:18:11.695|session_ended|lead-35-1|ignored||lead-35-1:session_ended:1
```

Session events of the lead (time, kind, session, key):

```
05:16:42.115|session_started|lead-35-1|lead-35-1:session_started:0
05:16:42.344|turn_started|lead-35-1|lead-35-1:turn_started:1
05:17:08.121|turn_ended|lead-35-1|lead-35-1:turn_ended:1
05:18:08.157|prompt_idle|lead-35-1|lead-35-1:prompt_idle:1
05:18:11.695|session_ended|lead-35-1|lead-35-1:session_ended:1
```

Notifications (time, key, kind, status, text):

```
```
