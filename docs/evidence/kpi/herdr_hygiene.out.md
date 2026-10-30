# herdr_hygiene

AS_OF `2026-10-22T08:00:00Z` (nominal). Measured live at `2026-10-22T08:55:23Z`. Definition key `herdr_hygiene`. Script `herdr_hygiene.py`.

**A Phase 0 janitor wave (rd reap, herdr event recorder) is running while the baseline is taken and may close finished tabs or kill claude --bg leftovers. Treat these numbers as the state at measured_at, not as a stable baseline; compare against the next run, not against AS_OF.**

Live measurement; herdr keeps no history, so as_of itself cannot be reconstructed.

## Counts

|what|count|
|-|-|
|workspaces (repo workspaces)|29|
|separator workspaces|7|
|tabs|50|
|panes|51|
|agents|25|
|finished-but-open tabs (done + idle)|20 (17 done, 3 idle)|
|of those older than 24 h (known age)|2 of 20 with a known age|
|finished tabs with unknown age|0|
|`claude --bg` leftovers|2 (blocked: 2)|

Tabs by status: blocked 1, done 17, idle 3, unknown 25, working 4.
Agents by status: blocked 1, done 17, idle 3, working 4.
Workspaces by status: blocked 1, done 11, idle 1, unknown 14, working 2.

Workspace labels that appear more than once: hermes-agent (2), homelab-private (2).

## Workspaces by sidebar group

|group|workspaces|tabs|
|-|-|-|
|APPS|4|9|
|HERD|1|1|
|INFRA|3|3|
|OTHER|3|5|
|PERSONAL|2|3|
|TOOLING|13|18|
|WORK|3|4|

## Finished-but-open tabs

no: the herdr API returns sequence counters, not timestamps; age_hours is the time since the last entry in the agent's Claude transcript.

Age buckets: 1-6h 6, 6-24h 1, <1h 11, >3d 2.

|workspace|tab|status|repo|age (h)|events since state change|
|-|-|-|-|-|-|
|sy-serendipity|1|idle|sy-serendipity|193.4|7031|
|dotfiles|1|idle|dotfiles|89.2|1883|
|SourceRoot|1|idle|-|21.9|424|
|basalt-ui|fan w44-fixtures|done|basalt-ui|3.4|88|
|homelab-private|1|done|homelab-private|1.6|70|
|rb|1|done|rb|1.5|60|
|homelab|1|done|homelab|1.4|56|
|basalt-ui|fan w44-seam|done|basalt-ui|1.3|53|
|weatherorb|orchestrator|done|weatherorb|1.0|42|
|hermes-agent|1|done|hermes-agent|0.9|32|
|epos.student-enrolment|1|done|epos.student-enrolment|0.9|33|
|basalt-ui|mother|done|basalt-ui|0.8|28|
|agent-gateway|wave 12|done|agent-gateway|0.7|26|
|prometheus-scripts|2|done|prometheus-scripts|0.6|21|
|prometheus-scripts|<label withheld>|done|prometheus-scripts|0.3|11|
|basalt-ui|fan w44-eventlist|done|basalt-ui|0.3|4|
|basalt-ui|fan w44-s5page|done|basalt-ui|0.3|12|
|SourceRoot|2|done|-|0.2|2|
|prometheus-epx|1|done|prometheus-epx|0.2|1|
|usage-tracker|wave 1|done|usage-tracker|0.1|0|

## claude --bg leftovers

Source: claude agents --json (kind = background). Older than 24 h: 2.

|id|repo|state|started|age (h)|last activity (h ago)|
|-|-|-|-|-|-|
|4eca7240|research-gateway|blocked|2026-09-22T23:32:10Z|705.4|705.1|
|7d5572c0|weatherorb|blocked|2026-10-06T06:15:02Z|386.7|386.7|

## rd agents cross-check

Rows 27 by lane {'bg': 2, 'herdr': 25}; herdr lane rows 25 vs `herdr agent list` 25; bg rows 2 vs claude background agents 2; consistent: True.

## Notes

- Tabs with agent_status `unknown` hold a plain shell or an agent herdr does not detect; they are not counted as finished.
- Separator workspaces (labels starting with a rule) only group the sidebar and are excluded from repo_workspaces.
- age_hours is the time since the agent's last transcript entry; a later resume or a janitor message writes a new entry and makes the tab look younger.
- Terminal titles are free text and are not written to this file.
