# F2 gate: the real requests

Filed with `factory issue new` against dotfiles (manifest v0, `deploy.mode: make`, hold 15m); no one typed into a lead's pane.

| Issue | Request | Commit | Ship | Hold | Verdict |
|-|-|-|-|-|-|
| 29 | `hc-resume` keeps `--model/--effort` | `cae41b7` | 05:10Z | green | closed **undeployed**: no `make deploy`, the hold's `make verify` ran on a checkout one commit behind |
| 30 | `docs/remote-dev.md` says when `rd` falls back | `dde7371` | 05:39Z | green | closed undeployed, the same way |
| 31 | `rd close` after a merge removed the worktree | `7ff39fb` | 06:22Z | green | closed undeployed; the lead's evidence said "scripts are live from the checkout", which was false |
| 41 | `rd work` drops its prompt (software-factory#31) | `b292f6d` | 09:09Z | deployed `254a765` holds `7eaf164`, `make verify` green | **pass**, under PR #30 |
| 42 | `make deploy` restarts a changed long-running script | `05126dd` | 09:41Z | deployed `05126dd` holds `05126dd`, `make verify` green | **pass**; `hc-resume` restarted by that deploy (process start 10:40 local), which also made 29's fix live |
| 43 | `RD_DRY_RUN=1` starts nothing | `b819889` | 10:06Z | deployed `b819889`, `make verify` green | **pass**; one `ship` refused for missing infra evidence first. Proven by the lead: the same command that started a session at 10:25 printed its plan at 11:25 |

Verdict: the first three exposed that the machine could close an Issue whose change never reached production. The fix (software-factory
PR #30: the hold reads `make version` and requires the sha where the work landed) went live at 08:59Z; the lead deployed 29–31 by hand
(dotfiles fast-forwarded 07:42Z). 41–43 then shipped end to end under it. Classify chose Sonnet/medium for all six.
