# Infra alerts: ClickStack parity for the Beszel rules (Issue 2099, 2026-11-18)

Question: can the factory stop polling the Beszel hub (decision A4) because ClickStack alerts reach the door and cover every
rule the Beszel intake evaluates, on each machine Beszel covers (vps, homelab, mini)? Method: the rules in
`apps/server/src/domains/intake/beszel-rules.ts` and their thresholds in `config/infra.json`, against the live alert list
(`agw hdx query clickstack_get_alert`, each alert read with its evaluation history), the "Infra - Hosts" dashboard tiles the
alerts run on, the series each host really sends (`clickstack_table` over the last hour), and the signals the door stored from
those alerts (`factory signal list`). No hostnames and no secrets here.

## Verdict

**Not yet.** Memory, disk and swap growth are proven on the machines where they fired; load, swap level, the mini's silence and
the mini's paging series have no ClickStack alert, and homelab has no firing yet. The Beszel
intake stays until the vps repo adds the missing alerts (a signal asks for them: see "Gaps"). Nothing is dropped silently.

## Path of an alert

Every infra alert in ClickStack carries the one webhook the 41 app alerts use (the same webhook id on both), the HyperDX generic
webhook parsed by `apps/door/src/parsers.ts` (`parseHyperdx`). The door routes by the alert's name to a repo; all infra alerts
are routed to the `vps` repo today (including the one about the mini's filesystem). The group value (`host.name`, plus the
mount point or container name) is in the signal's text, not in the route.

## Parity table

Beszel thresholds are `config/infra.json` defaults (the mini's host entry has no override). A ClickStack window is
`interval x numConsecutiveWindows`.

| Beszel rule | Beszel threshold | ClickStack alert (id) | Threshold and window | vps | homelab | mini |
|-|-|-|-|-|-|-|
| memory | used >= 92% for 15 min | Infra memory >= 90% (6afca40e86da9b7a9c088b9b) | avg `system.memory.utilization` used, by `host.name`; >= 0.90, 5m x 3 = 15 min | proven: signal 2026-11-17 19:25 (resolved, group `vps`) | evaluates (series present, the newest 20 evaluations OK), no signal yet: never fired | evaluates (series present, OK), never fired |
| disk, level | used >= 90% for 10 min | Infra filesystem >= 85% (6afca40d86da9b7a9c088b8f), host `mini` excluded by the tile | avg `system.filesystem.utilization` per host and mount; >= 0.85, 5m x 3 = 15 min | proven: signal (group `vps /`) | evaluates, never fired | not this alert (below) |
| disk, level, mini | same, mini | Infra mini filesystem >= 93% (6afcd240c162ceda14bdc05c) | same series, host `mini` only; >= 0.93, 5m x 3 = 15 min | n/a | n/a | proven: signals 2026-11-17 23:00 and 2026-11-18 02:15 (fired and resolved, group `mini /System/Volumes/Data`), routed and filed |
| disk, fill rate | full within 24 h at >= 0.5 GB/h, only from 85% | none, and none needed | the fill rule speaks only at >= `minPct` 85%, so every case it can report is already past the level alert's 85% (vps, homelab); the mini sits at 89-95% by itself, which is why its level is 93% (Beszel's mini fill rule fired twice on a write burst, both Issues closed as false alarms, `alert-sources/README.md`) | covered by the level alert | covered by the level alert | covered by the level alert at 93% (the owner's tuning in the vps repo) |
| swap, level | used >= 8 GB for 10 min | **none** | tile "Swap used (%)" exists (`system.paging.utilization`), no alert | gap | gap | gap: the mini sends no paging series at all (`system.paging.*` empty for `mini` over the last hour) |
| swap, growth | grew >= 2 GB in 120 min, from 1 GB | Infra swap-out >= 100 MiB per 5m (6afca40f86da9b7a9c088ba1) | increase of `system.paging.operations` page_out major, by `host.name`; >= 100 MiB, 5m x 3 = 15 min. A different measure (traffic out, not net growth), but it fires for the same event, a host pushing memory to swap | proven: two signals 2026-11-17 19:25-19:30 (group `vps`) | evaluates, never fired | gap: no paging series |
| load | load1 >= 3 per thread for 15 min | **none now** (alerts "Infra load5 per core >= 1.5" and ">= 4" fired 17 and 1 times on 2026-11-17 and were removed) | tile "Load5 per core" exists, no alert | gap | gap | gap (the mini's load5 averaged 27 over the last hour: the series is there) |
| silent | no sample for 10 min | vps host silent < 1 sample (6afca41486da9b7a9c088be4); homelab host silent < 1 sample (6afd5105ca2acb2dfa5c236a) | count of `system.cpu.utilization` for the host; below 1, 5m x 2 = 10 min | proven: signal 2026-11-17 19:25 (resolved) | evaluates, never fired | gap: no tile, no alert for `mini` |

Container alerts (restarts, unhealthy) have no Beszel rule: they are new coverage, not parity.

## Gaps

| Rule | Machines | What is missing |
|-|-|-|
| load | vps, homelab, mini | an alert on `Load5 per core` (tile `6afca3f986da9b7a9c088acd`), by host, at Beszel's level (load1 3 per thread, 15 min), or a level the vps repo prefers: the two it had fired on a host that runs hot by design |
| swap, level | vps, homelab | an alert on `system.paging.utilization` used, by host; Beszel's threshold is an absolute 8 GB, the series is a share, and the vps swap reads about 69% today, so the level has to be set against that |
| swap, level and growth | mini | the mini sends no `system.paging.*`: a metric from the agent on the mini (the host-agent is a dotfiles Issue), then the same two alerts |
| silent | mini | a tile "host-agent samples: mini" and an alert beside the vps and homelab ones, because a grouped absence alert cannot notice a host whose series vanished entirely |
| delivery proof | homelab | none of its alerts has fired, so no signal shows the path for `homelab`; one deliberate firing (a throwaway threshold, then removed) closes it |

The host loop (`host_samples`, admission) is unchanged by this: the mini's swap and load stay read directly there, which is
the control loop and not an alert.

## What happens next

The removal (adapter, rules, `FACTORY_BESZEL_POLL`, wiring, tests, A4) waits until every gap row is closed in ClickStack and its
alert has either fired and reached a signal or been fired once on purpose. This file is updated with the proof then.
