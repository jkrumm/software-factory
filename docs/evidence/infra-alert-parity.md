# Infra alerts: ClickStack parity for the Beszel rules (Issue 2099, 2026-11-18)

Question: can the factory stop polling the Beszel hub (decision A4) because ClickStack alerts reach the door and cover every
rule the Beszel intake evaluated, on each machine Beszel covered (vps, homelab, mini)? Method: the rules in
`beszel-rules.ts` and their thresholds in `config/infra.json` (both removed in this change; `git show 00871d55:apps/server/src/domains/intake/beszel-rules.ts`),
against the live alert list (`agw hdx query clickstack_get_alert`, each alert read with its evaluation history), the
"Infra - Hosts" dashboard tiles the alerts run on, the series each host really sends (`clickstack_table` over the last hour), and
the signals the door stored from those alerts (`factory signal list`). No hostnames and no secrets here.

## Verdict

**Every rule has a ClickStack alert or a stated reason it needs none.** A first pass (2026-11-18, morning) found five gaps and
filed them with the vps repo (Issue 2242); the second pass below re-read each alert from ClickStack itself after that Issue
shipped, and the Beszel intake was removed.

## Path of an alert

Every infra alert in ClickStack carries the one webhook the 41 app alerts use (the same webhook id on every alert read here),
the HyperDX generic webhook parsed by `apps/door/src/parsers.ts` (`parseHyperdx`). The door routes by the alert's name to a repo;
all infra alerts are routed to the `vps` repo (including the one about the mini's filesystem). The group value (`host.name`, plus the
mount point or container name) is in the signal's text, not in the route.

## Parity table

Beszel thresholds are the `config/infra.json` defaults (no host overrode one). A ClickStack window is
`interval x numConsecutiveWindows`. "Proven" means a stored signal from that alert, or from an alert of the same webhook and tile
family on that host, shows the path; "evaluates" means the alert reads the host's series and its evaluation history is OK with no
execution error, and no signal exists because it never fired.

| Beszel rule | Beszel threshold | ClickStack alert (id) | Threshold and window | vps | homelab | mini |
|-|-|-|-|-|-|-|
| memory | used >= 92% for 15 min | Infra memory >= 90% (6afca40e86da9b7a9c088b9b) | avg `system.memory.utilization` used, by `host.name`; >= 0.90, 5m x 3 = 15 min | proven: signal 2026-11-17 19:25 (resolved) | evaluates | evaluates |
| disk, level | used >= 90% for 10 min | Infra filesystem >= 85% (6afca40d86da9b7a9c088b8f) | avg `system.filesystem.utilization` per host and mount, host `mini` excluded by the tile; >= 0.85, 5m x 3 = 15 min | proven: signal (group `vps /`) | evaluates | see next row |
| disk, level, mini | same | Infra mini filesystem >= 93% (6afcd240c162ceda14bdc05c) | same series, host `mini` only; >= 0.93, 5m x 3 = 15 min | n/a | n/a | proven: signals 2026-11-17 23:00 and 2026-11-18 02:15 (fired and resolved, group `mini /System/Volumes/Data`), filed |
| disk, fill rate | full within 24 h at >= 0.5 GB/h, only from 85% | none, none needed | the fill rule spoke only at >= 85%, so every case it could report is already past the level alert's 85% (vps, homelab); the mini sits at 89-95% by itself, which is why its level is 93% (Beszel's mini fill rule fired twice on a write burst, both Issues closed as false alarms: `alert-sources/README.md`) | covered by the level alert | covered by the level alert | covered by the level alert at 93% |
| swap, level | used >= 8 GB for 10 min | Infra swap used >= 99% (30m) (6afd682cca2acb2dfa5c273d) | avg `system.paging.utilization` used, by `host.name`; >= 0.99, 15m x 2 = 30 min. A ratio, not 8 GB: the VPS swap is far smaller than 8 GB, so the byte level could never fire there. vps reads about 65% and its CI peak did not hold 99% for two windows | evaluates (OK) | evaluates (OK) | no series (below) |
| swap, growth | grew >= 2 GB in 120 min, from 1 GB | Infra swap-out >= 100 MiB per 5m (6afca40f86da9b7a9c088ba1) | increase of `system.paging.operations` page_out major, by `host.name`; >= 100 MiB, 5m x 3 = 15 min. A different measure (traffic out, not net growth) that fires for the same event | proven: two signals 2026-11-17 19:25-19:30 | evaluates | no series (below) |
| load | load1 >= 3 per thread for 15 min | Infra load5 per core >= 8 (30m) (6afd682cca2acb2dfa5c2728) | avg `system.cpu.load_average.5m` / cores, by `host.name`; >= 8, 15m x 2 = 30 min. Far less sensitive than Beszel's 3 per thread: the vps lead set it from the tile's own values (vps peak 4.9, mini peak 11.1 in one window, homelab 0.5), because the two earlier alerts at 1.5 and 4 fired 18 times on one afternoon. A heavy build holding the mini above 8 for 30 min pages | evaluates (OK) | evaluates (OK) | evaluates (history OK and PENDING: the mini touches the line) |
| silent | no sample for 10 min | vps host silent < 1 sample (6afca41486da9b7a9c088be4); homelab host silent < 1 sample (6afd5105ca2acb2dfa5c236a); mini host silent < 1 sample (6afd682dca2acb2dfa5c274d) | count of `system.cpu.utilization` for the host; below 1, 5m x 2 = 10 min | proven: signal 2026-11-17 19:25 (resolved) | proven: a deliberate firing 2026-11-18 ~09:00 (threshold raised for a minute, then restored): the door stored signal `signal_01a1ede2-83b6-70be-98c7-e00b05a3cf80`, filed as an Issue of the vps repo, then closed dropped | evaluates (OK) |

Container alerts (restarts, unhealthy) have no Beszel rule: they are new coverage, not parity.

## The one rule with no alert

**The mini's swap.** The mini's agent sends `system.paging.*` series but every value is zero (usage 0 in all states, utilization empty,
page-out 0 over 12 hours), so a level or growth alert cannot work there. The mini's swap and load stay read directly by the
factory's own host loop (`host_samples`, the admission ceilings, `factory read machine`), which is the control loop and not an
alert: it refuses to start new work, it does not page.

## What changes for a person

- Infra signals come in as `hyperdx`, so their origin is "application", where Beszel's was "infrastructure". The origin comes from the
  source name only; a split by alert name would be a second mapping, and it is left out until it is missed.
- All infra alerts are routed to the `vps` repo by name, whatever host they speak of; the incident group is the repo's host
  (`host:vps`). Beszel's signals went to the host's own repo (the mini's to `dotfiles`). The door's routes are the owner's; a route per
  alert to another repo is a `factory door route-set`.
- The load level is looser and the swap level is a ratio at 99%: a host can be in trouble for longer before a signal appears. The
  levels are the vps repo's (Issue 2242, `docs/observability.md` there); this file records what they replaced.
