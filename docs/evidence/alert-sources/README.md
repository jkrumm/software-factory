# Alert sources, wired end to end (Issue 448, 2026-11-08)

Question: is every Uptime Kuma monitor, HyperDX alert and Beszel rule heard by the factory, on the right repo, with a
triage outcome? Method: each source's own list against the door's routes, then one live test per source. No hostnames and
no secrets here; the private Kuma config is counted, never named.

## Inventory

| Source | Live | Reaches the factory | Not wired | Should not page |
|-|-|-|-|-|
| Uptime Kuma | 99 leaf monitors in 22 groups | all 99 carry the `Factory door` notification; 2 also carry `ntfy - Alerts` (the factory's own push and the dev host's push: NL5's direct page) | none | the 22 groups (they never notify); the work-related monitors of the private config (a work repo hears only the owner) |
| HyperDX | 34 alerts | 24 to the `Factory door` webhook | 10 `weatherorb-*` alerts post to WeatherOrb's own receiver and never reach the factory | none: every alert has one channel, none uses Slack or ntfy |
| Beszel | 3 systems (mac mini, homelab, vps), all up | all 3 are hosts of `config/infra.json`, polled by the factory (no door) | none | none |
| GitHub, launchd | pollers, not part of this check | | | |

Kuma's 99: 78 are in public configs (homelab, the mini-door fragment, the factory's own push) and 21 only in the private
config (`homelab-private`, counted, not named). The earlier scratch monitors (`Scratch Routed 287 - HTTP`,
`zz-scratch196 - Push`) are no longer in Kuma: nothing to delete. `Software Factory - Push` was unrouted; it is routed
to `software-factory` now.

`routes.tsv` is the proposed registry for the 78 public Kuma monitors and the 24 HyperDX alerts (source, monitor, repo;
the monitor of a HyperDX alert is its name, which is what `Alert for "<name>"` quotes). The repo is the monitor's owner by
`docs/evidence/signals/topology.out.json` where it has one, else by its name.

## Live tests

| Source | Fired | Arrived | Repo | Triage outcome | Recovery |
|-|-|-|-|-|-|
| Kuma | a throwaway push monitor (60 s interval) with the `Factory door` notification, routed by this lead | signal `kuma`, 1 min after creation | `software-factory` (the route) | `filed`, incident Issue 449 | a push `up` 5 s later: signal `amended`, Issue 449 closed by the factory (`Kuma is up again`) |
| Kuma, second alert | a second throwaway monitor, both down within the same second | two signals | `software-factory` | **two** Issues (450, 451), no `incident` join: `software-factory` has no host in `config/infra.json`, so `groupOf` returns null | both closed on `up` |
| HyperDX | a throwaway dashboard tile (count of any log) with a 1-minute alert, threshold 0, channel `Factory door` | signal `hyperdx`, about 20 s after the first evaluation | `software-factory` (the route on the alert's name) | `filed`, incident Issue 452; a lead was admitted, started and closed it as the synthetic test it was | the `OK` webhook was not seen as a signal (the lead had closed the Issue first) |
| Beszel | not fired: a rule needs real pressure on a host | two real signals today (`macmini: disk filling fast`) | `dotfiles` (host `macmini`) | `filed`, Issues 329 and 392 | both closed by their leads as false alarms (a 20-minute extrapolation over a transient write burst) |

Everything throwaway is deleted: both Kuma monitors, the HyperDX alert and dashboard, and the routes set for them.

## What this found

1. **The lead's token cannot finish the routing.** `GET /door/routes` is the owner's, and a lead may route only to its
   own repo, so the unrouted list and routes to other repos need the owner's token. `routes.tsv` applies with it:
   `while IFS=$'\t' read -r s m r; do factory door route-set --source "$s" --monitor "$m" --repo "$r"; done < <(tail -n +2 routes.tsv)`
   (a route that exists with the same repo is a no-op; one with another repo is the owner's to look at). The Decision on
   how to apply it was left open by default (the Judge), so `factory door routes` still has to be read with that token.
2. **The 30-minute forward to ntfy is not built** (`docs/architecture.md`, "Not built yet"; NL5). Today ntfy is used only
   by the two monitors that carry `ntfy - Alerts`; nothing forwards an unsolved alert.
3. **No correlation for a project without a host.** Two alerts of `software-factory` never join an incident; of the
   mini's repos only `dotfiles` has a host in `infra.json`. A live incident join needs a
   `project.yaml` host (the topology comment already allows it) or two alerts routed to `dotfiles`.
4. **Every HyperDX alert starts a lead at once.** A firing alert is `filed` and admitted with no heal grace; the Kuma
   push monitors behaved the same, but their `up` closed the Issue before a lead started.
5. **Stale rows likely remain** for monitors that left Kuma (`Agent Gateway - Push`, `Audio Gateway - HTTP`,
   `Warden Backup - Push`, `Warden Loop - Push`, `WeatherOrb Archive - Push`, `Garmin Auto-Relogin - Push`, `API - HTTP`,
   `Dashboard - HTTP`, `Hermes - HTTP`, `Image Gen Gateway - HTTP`): `factory door routes` shows whether routes exist.
6. **Beszel's `disk_growth` rule fired twice today on a transient write burst**, and each firing started a lead.

Follow-ups are filed as signals (see the Issue's report).
