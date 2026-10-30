# quota — Max headroom and Max vs IU split

AS_OF `2026-10-22T08:00:00Z`. Definition key `max_headroom`. Script `quota.py`.

## Source and coverage

Best history: ~/Library/Logs/devhost-health.log (heartbeat, one `quota 5h N% · 7d N%` per run). The only source that spans weeks; ~/.claude/logs fetch_usage has real timestamps but 3-day retention; usage.db has no utilisation columns; agent-gateway logs carry request metadata only.

Coverage: 2026-09-08T17:50:01Z to 2026-10-22T07:59:21Z (43.6 days, 12441 runs, 12082 usable readings, 358 runs with `quota unavailable`).

## Time axis

piecewise-linear over anchors: host reboots (wtmp + kern.boottime) and scheduled weekly resets snapped to Wednesday 16:00:00 UTC. Median 302.7 s per run.

Validation against 209 real `fetch_usage` timestamps: 5 h within 2 points 99.0%, 7 d within 1 point 100.0% at offset 0; best offset 0 s (99.0% / 100.0%).

## Distribution

|window|n|mean|p50|p75|p90|p95|p99|max|>=90%|>=100%|hours >=90%|
|-|-|-|-|-|-|-|-|-|-|-|-|
|7-day raw|12082|50.05|46.0|82.0|96.0|96.0|100.0|100|18.9%|2.5%|192.5|
|7-day excl. suspect flat|10971|45.4|38.0|72.0|91.0|96.0|100.0|100|10.7%|2.8%|99.1|
|5-hour raw|12083|7.56|2.0|12.0|22.0|30.0|48.0|70|0.0%|0.0%|0.0|
|5-hour excl. suspect flat|10972|8.32|4.0|13.0|23.0|31.0|49.0|70|0.0%|0.0%|0.0|

## Days at the limit

Days (UTC) whose 7-day peak reached >= 90 %: 12 of 45 (7 without the suspect flat span). Days that reached 100 %: 3.

The 7-day window last sat at 100 % from 2026-09-29T16:14:45Z to 2026-09-30T15:57:27Z (520.0 h before AS_OF).

|start|end|hours|
|-|-|-|
|2026-09-09T14:16:54Z|2026-09-09T15:57:28Z|1.7|
|2026-09-29T16:14:45Z|2026-09-30T15:57:27Z|23.7|

5-hour: never sampled at 100 % in the heartbeat history (max 70 %); fetch_usage max 30 % over 209 samples.

## Weekly resets

Schedule: Wednesday 16:00:00 UTC (18:00 CEST / 17:00 CET). 6 of 8 detected 7-day drops land within 63 minutes of Wednesday 16:00 UTC on the reboot-only axis (residuals in `resets`); the live cache names the same weekday and time for the next reset; fetch_usage saw the last one between 15:58 and 16:04 UTC. The other drops are unscheduled full resets.

Live cache at run time: next weekly reset 2026-10-28T16:00:00Z (Wed 16:00 UTC).

Last reading before AS_OF (2026-10-22T07:59:21Z): 5 h 6 %, 7 d 14 %.

|time (UTC)|weekday|from 7d|to 7d|5h also reset|kind|residual vs Wed 16:00 (min)|
|-|-|-|-|-|-|-|
|2026-09-09T16:02:30Z|Wed|100|0|no|scheduled weekly (Wed 16:00 UTC)|-63.1|
|2026-09-20T06:38:08Z|Sun|96|2|no|unscheduled|-4889.9|
|2026-09-23T16:02:30Z|Wed|55|0|no|scheduled weekly (Wed 16:00 UTC)|10.9|
|2026-09-30T16:02:30Z|Wed|100|0|no|scheduled weekly (Wed 16:00 UTC)|15.2|
|2026-10-07T16:02:30Z|Wed|79|0|yes|scheduled weekly (Wed 16:00 UTC)|14.3|
|2026-10-14T16:02:30Z|Wed|79|0|no|scheduled weekly (Wed 16:00 UTC)|-16.8|
|2026-10-17T13:34:13Z|Sat|98|0|yes|unscheduled|4142.1|
|2026-10-21T16:02:30Z|Wed|98|0|no|scheduled weekly (Wed 16:00 UTC)|-47.9|

## Weekly cycles (reset to reset)

|start|end|peak 7d|peak at|hours >=90%|ended by reset|
|-|-|-|-|-|-|
|2026-09-08T17:50:01Z|2026-09-09T15:57:28Z|100|2026-09-09T14:16:54Z|6.9|yes (partial)|
|2026-09-09T16:02:30Z|2026-09-20T06:33:06Z|96|2026-09-15T14:05:16Z|117.5|yes|
|2026-09-20T06:38:08Z|2026-09-23T15:57:28Z|55|2026-09-23T15:37:20Z|0.0|yes|
|2026-09-23T16:02:30Z|2026-09-30T15:57:27Z|100|2026-09-29T16:14:45Z|36.2|yes|
|2026-09-30T16:02:30Z|2026-10-07T15:57:27Z|79|2026-10-07T15:02:00Z|0.0|yes|
|2026-10-07T16:02:30Z|2026-10-14T15:57:26Z|79|2026-10-14T15:42:14Z|0.0|yes|
|2026-10-14T16:02:30Z|2026-10-17T13:29:10Z|98|2026-10-17T13:19:02Z|4.5|yes|
|2026-10-17T13:34:13Z|2026-10-21T15:57:26Z|98|2026-10-21T12:39:59Z|27.3|yes|
|2026-10-21T16:02:30Z|2026-10-22T07:59:21Z|14|2026-10-22T07:59:21Z|0.0|no (log end) (partial)|

Complete cycles: 7, peaks [96, 55, 100, 79, 79, 98, 98], 4 peaked at >= 90 %, median peak 96.

## Suspect flat span

- 2026-09-16T09:31:49Z to 2026-09-20T06:33:06Z (93.0 h, 1111 runs): 5 h 0 %, 7 d 96 % unchanged. Readings did not move although a weekly reset falls inside the span, and Max usage in usage.db fell to 0.0341 of the prior week's rate while 739 heartbeat lines name failing Max routes: Max was effectively unavailable for these days (a limit the heartbeat does not record, or a stale reading, or both); the 7-day value inside the span is not trustworthy.

- Max usage in usage.db over the same days: 183.7 records/day inside vs 5379.1 in the 7 days before (ratio 0.0341): per day 54, 487, 10.

## Max vs IU per week

|week|Max cost $|IU cost $|Max share of cost|Max io tokens (M)|IU io tokens (M)|Max share of io tokens|
|-|-|-|-|-|-|-|
|2026-W16|0|0|-|0.0|4.6|0.0%|
|2026-W18|255|19|92.9%|1.8|0.1|96.5%|
|2026-W19|568|26|95.5%|3.1|0.0|98.7%|
|2026-W20|905|20|97.8%|6.1|0.1|98.8%|
|2026-W21|1,761|43|97.6%|14.6|34.9|29.4%|
|2026-W22|670|258|72.2%|5.2|175.4|2.9%|
|2026-W23|397|1,748|18.5%|4.8|1,186.4|0.4%|
|2026-W24|868|513|62.8%|9.3|344.9|2.6%|
|2026-W25|927|16|98.3%|11.7|6.5|64.4%|
|2026-W26|0|2|0.0%|0.0|1.2|0.0%|
|2026-W27|732|15|97.9%|10.2|3.2|76.3%|
|2026-W28|1,538|4|99.8%|22.8|2.0|92.0%|
|2026-W29|3,096|3|99.9%|24.9|1.4|94.8%|
|2026-W30|1,550|3|99.8%|11.2|1.4|88.7%|
|2026-W31|3,480|17|99.5%|24.7|12.5|66.3%|
|2026-W32|3,852|49|98.8%|29.1|21.0|58.1%|
|2026-W33|1,889|5|99.7%|12.4|5.2|70.6%|
|2026-W34|4,181|5|99.9%|34.0|1.1|96.8%|
|2026-W35|3,682|10|99.7%|25.4|3.6|87.5%|
|2026-W36|2,781|98|96.6%|14.4|20.1|41.8%|
|2026-W37|4,002|119|97.1%|35.0|25.4|57.9%|
|2026-W38|1,004|65|94.0%|30.5|103.5|22.8%|
|2026-W39|3,047|129|95.9%|43.0|125.6|25.5%|
|2026-W40|2,622|79|97.1%|37.1|111.7|24.9%|
|2026-W41|1,954|114|94.5%|25.5|131.9|16.2%|
|2026-W42|7,483|205|97.3%|99.9|266.1|27.3%|
|2026-W43|1,483|45|97.1%|16.3|66.6|19.7%|

|window|Max cost $|IU cost $|Max share of cost|Max share of io tokens|
|-|-|-|-|-|
|14d|9,593|301|97.0%|24.7%|
|30d|16,413|565|96.7%|24.1%|
|90d|41,587|939|97.8%|32.4%|
|all|54,728|3,610|93.8%|17.2%|

- Max cost_usd is the API-list-price equivalent of subscription usage (sunk cost), IU cost_usd is billed per token: the two are not the same currency of effort.
- Weeks are ISO weeks (Mon-Sun UTC), not Max reset windows (Wed 16:00 UTC).
- Sources agent-gateway-iu and opencode can describe the same OpenCode episodes; no de-duplication is attempted here (cost attribution owns that).
- agent-gateway-sessions rows are session markers with no tokens.

## Notes

- Utilisation is what Anthropic's usage endpoint reports (integer percent of the plan limit), relayed by agent-gateway GET /api/usage into the heartbeat.
- Small downward steps (1-4 points) inside a week exist in the series and are not resets; a reset is a drop of >= 20 points to <= 15.
- Both windows reset together on unscheduled resets (5h falls as well): those are not the weekly schedule.
