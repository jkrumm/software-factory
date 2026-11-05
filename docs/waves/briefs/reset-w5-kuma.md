Branch: reset-w5-kuma
Title: feat(kuma): Software Factory - Push, the factory's heartbeat monitor
Owned files: `uptime-kuma/monitors.yaml` (one new entry), the file outside git `~/.config/uptime-kuma/factory-push-url` on the mini (mode 0600). Never: other monitors, `homelab-private`, any tracked file holding a token or URL with a token.

# Brief: reset row 6, the homelab half — a push monitor for the factory heartbeat

Read `AGENTS.md` and `.claude/rules/uptime-kuma-monitors.md` first (naming, `type: push` with `maxretries: 0`, `make uk-sync`, fetching
the push token with `api.get_monitor(id)["pushToken"]`, the push URL `http://localhost:3010/api/push/<token>` or the external one).

The software-factory server on the mini (`~/SourceRoot/software-factory`) now judges its own liveness ("the tick advanced and the queue
moved within 30 minutes", `GET /health` `heartbeat.ok`); a dotfiles pusher (`scripts/devhost-health-check.sh`, every 5 minutes, a
separate brief) pushes it to Uptime Kuma from `~/.config/uptime-kuma/factory-push-url`.

1. Add `Software Factory - Push` to `uptime-kuma/monitors.yaml`, in the group where the other mini push monitors live (`MacMini Dev
   Host - Push`, `MacMini Collie - Push`: follow their group and naming, so the name may need a `MacMini` subject prefix to match its
   siblings; the rule file decides), `type: push`, `interval: 600`, `retry_interval: 600`, `maxretries: 0` (the rule file's value;
   if the siblings use 1, follow the rule file and say so).
2. Dry-run the sync first and read it (only your `[CREATE]`, no drift), then apply with `make uk-sync`.
3. Fetch the new monitor's push token through the API, write the push URL (the local `http://localhost:3010/api/push/<token>` form if
   the mini reaches Kuma that way, else the external one; check what `~/.config/uptime-kuma/collie-push-url` uses and match it) to
   `~/.config/uptime-kuma/factory-push-url`, mode 0600. Never print the token into a commit, a PR or your report.
4. Prove it: `curl -fsS "$(cat ~/.config/uptime-kuma/factory-push-url)?status=up&msg=manual%20test"` and confirm the monitor went up
   (API or `make` target).

Commit the YAML (conventional commit, no token), push the branch `reset-w5-kuma`, open a ready PR (or follow the repo's own rule if it is
direct-to-master: check `AGENTS.md`). Report the PR URL or commit, the sync output with any token redacted, the monitor id, and the
proof. Never end a turn on a background shell or a wait.
