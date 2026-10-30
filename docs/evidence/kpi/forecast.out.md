# Factory weekly capacity: today vs full design (ADR-007 / ADR-008)

AS_OF 2026-10-22T08:00:00Z. `kpi/forecast.py`. Max in list USD and % of the weekly window (median; range = dearest..cheapest cycle). IU in cash USD.

## Capacity per week

|class|today Max $|today Max %|today IU $|design Max $|design Max %|design IU $|engine under ADR-008|
|-|-|-|-|-|-|-|-|
|agw_opencode_impl|1|0 (0-0)|27.9|1|0 (0-0)|27.9|iu (routine fixes, investigate)|
|agw_tools|469|14 (13-18)|91.3|469|14 (13-18)|91.3|unchanged (unclassified in ADR-008)|
|fleet_waves|2,369|74 (67-88)|0.0|3,077|95 (87-114)|0.0|max (features, waves, mothers, leads)|
|hermes|0|0 (0-0)|4.2|0|0 (0-0)|4.2|iu|
|other|5|0 (0-0)|0.8|5|0 (0-0)|0.8|unchanged|
|owner_interactive|1,018|32 (29-38)|5.1|1,018|32 (29-38)|5.1|max (owner's choice)|
|research|0|0 (0-0)|17.7|0|0 (0-0)|17.7|iu|
|**total**|3,862|120 (109-144)|146.9|4,570|142 (130-170)|146.9||
|recent 7 d (context)|6,586|204 (187-245)|228.6|||||

## Mother and lead wakes (assumption, not measurement)

- 6 mothers x (4 wakes + 1 rotation)/day, 3 leads x 6 wakes/day = 336 wakes/week.
- Wake = 0.25 x median wave session (19,300,523 tokens over 335 sessions, p90 86,098,260) = 4,825,131 tokens = $2.11 list (wave rate $0.44/M tokens).
- Mothers $442/week = 14 (12-16) %; leads $265/week = 8 (8-10) %.

## Per weekly cycle (7 complete cycles)

|cycle start|days|$/1 %|peak 7d %|owner $|owner % of window|owner % per 7 d|factory %|lapsed % today|design demand %|design lapsed %|design overflow %|
|-|-|-|-|-|-|-|-|-|-|-|-|
|2026-09-09|10.6|26.86|96|2,316|86.2|56.9|9.8|4|135.9|0.0|35.9|
|2026-09-20|3.39|27.18|55|1,048|38.5|79.6|16.4|45|67.6|32.4|0.0|
|2026-09-23|7.0|30.36|100|1,016|33.5|33.5|66.5|0.0|123.3|0.0|23.3|
|2026-09-30|7.0|32.26|79|707|21.9|21.9|57.1|21|100.9|0.0|0.9|
|2026-10-07|7.0|32.25|79|689|21.4|21.4|57.6|21|100.9|0.0|0.9|
|2026-10-14|2.89|35.29|98|796|22.5|54.5|75.5|2|106.3|0.0|6.3|
|2026-10-17|4.1|34.47|98|438|12.7|21.7|85.3|2|110.0|0.0|10.0|

- Owner-interactive share per cycle: p50 22.5 %, p90 57.6 % (per 7 d: p50 33.5, p90 66.0); ADR-008 reserve 15 %, exceeded in 7 of 7 cycles (per 7 d).
- Max lapsed per cycle today: p50 4.0 %, p90 30.6 %; design: p50 0.0 %, p90 13.0 %.
- Design demand per cycle: p50 106.3 %, p90 128.3 %; over 100 % in 6 of 7 cycles.

## Sensitivities (design, per week)

|case|Max $|Max %|IU $|
|-|-|-|-|
|agw_tools_all_to_iu|4,101|127 (116-153)|178.1|
|no_mothers_or_leads|3,862|120 (109-144)|146.9|
|wake_load_x2|5,277|164 (150-196)|146.9|
|wake_load_x4|6,692|208 (190-249)|146.9|
|waves_routine_10pct_to_iu|4,333|134 (123-161)|162.6|
|waves_routine_25pct_to_iu|3,977|123 (113-148)|186.3|

## Fleet waves by repo (Max list $/week, top)

|repo|$|
|-|-|
|shutterflow|760|
|basalt-ui|530|
|weatherorb|378|
|argo|354|
|prometheus-scripts|86|
|email-gateway|73|
|warden|55|
|agent-gateway|39|
|dotfiles|34|
|linewatch|17|
|research-gateway|8|
|hermes-agent|6|

## Notes

- Max rows are list-price equivalents (sunk subscription); IU rows are cash.
- Mother/lead load is an assumption set, not a measurement: no mother runs yet (report/05-decisions.md).
- Today's cycle % is the measured 7-day peak by construction ($/1 % is calibrated on the same cycles).
- A cycle's peak is censored at 100 %: where it hit 100, true demand was higher, so design demand and overflow there are lower bounds.
- recent_7d is a calendar 7 days spanning two resets (10-17 unscheduled, 10-21 scheduled); it is a burn-rate signal, not a window reading.
- claude-code agent-gateway:dispatch on IU stopped 2026-09-24; it inflates the 30 d IU rate versus recent_7d.
- OpenCode collector gap excluded from the 30 d divisor: 1.0 days.
- Own $/1 % check (cycle Max list / peak): [26.86, 27.18, 30.36, 32.26, 32.25, 35.29, 34.47] vs engine_policy [26.86, 27.18, 30.36, 32.26, 32.25, 35.29, 34.47].
