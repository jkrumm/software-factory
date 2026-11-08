# Repo contract audit (Reset row 13, 2026-11-06)

Every repo with a factory space under `~/SourceRoot` (`~/.config/factory/spaces.json`, 24 spaces) against the contract in
`docs/design.md` §9: `project.yaml` v0 on the default branch, `make check`, `deploy` and `verify`, `make version` where the
manifest's `deploy.mode` is `make`, and `make verify` exiting 0 on master today. WorkRoot is out of scope.

**Method.** Manifest: `git cat-file` on `origin/master:project.yaml`, and `factory project list` for `manifestError`. Targets: a
static read of each Makefile. Verify: `make verify` run once in each repo's main checkout on 2026-11-06 (all verify targets are
read-only probes), exit code recorded. Filed with `factory issue new`, key `rs11-row13-audit:<repo>`; this Issue changed no
repo's code.

**Result.** 3 pass, 21 fail, 0 broken manifests: `factory project list` reports `manifestError: null` for every project, so no
failing repo is hiding an unfiled upkeep Issue. 15 fail on the missing manifest alone, 5 (vps, dotfiles-private, brain, finances, home) on the manifest plus a second gap, and argo on a red verify only.

| Repo | project.yaml | check | deploy | verify | version | `make verify` | Result | Issue |
|-|-|-|-|-|-|-|-|-|
| software-factory | yes | yes | yes | yes | yes | green | pass | |
| dotfiles | yes | yes | yes | yes | yes | green | pass | |
| weatherorb | yes | yes | yes | yes | yes | green | pass | |
| argo | yes | yes | yes | yes | yes | **red** (exit 2: `ECONNREFUSED 127.0.0.1:5432` in the stderr log since start) | fail | 133 |
| homelab | no | yes | yes | yes | n/a | green | fail | 121 |
| homelab-private | no | yes | yes | yes | n/a | green | fail | 122 |
| vps | no | yes | yes | yes | n/a | green, vacuous (no recorded deploy to verify) | fail | 123 |
| dotfiles-private | no | no | no | no | n/a | no Makefile | fail | 124 |
| agent-workflows | no | yes | yes | yes | n/a | green | fail | 125 |
| hermes-agent | no | yes | yes | yes | n/a | green | fail | 126 |
| modelpick | no | yes | yes | yes | n/a | green | fail | 127 |
| linewatch | no | yes | yes | yes | n/a | green | fail | 128 |
| usage-tracker | no | yes | yes | yes | n/a | green | fail | 129 |
| rb | no | yes | yes | yes | n/a | green | fail | 130 |
| email-gateway | no | yes | yes | yes | n/a | green | fail | 131 |
| jkrumm.com | no | yes | yes | yes | n/a | green | fail | 132 |
| iris | no | yes | yes | yes | n/a | green | fail | 134 |
| brain | no | no | no | no | n/a | no Makefile | fail | 135 |
| basalt-ui-obsidian | no | yes | yes | yes | n/a | green | fail | 136 |
| finances | no | yes | yes | no | n/a | no target | fail | 137 |
| home | no | yes | no | no | n/a | no target | fail | 138 |
| rollhook | no | yes | yes | yes | n/a | green | fail | 139 |
| basalt-ui | no | yes | yes | yes | n/a | green | fail | 140 |
| free-planning-poker | no | yes | yes | yes | n/a | green | fail | 141 |

`version` is required only when the manifest says `deploy.mode: make`; a repo without a manifest is on the defaults (mode
`none`), so "n/a" there. Each Issue asks for the manifest to say how the repo really ships, and for `make version` in the same
change if that mode is `make`.

## Notes

- **Defaults are not a pass.** A repo with no manifest runs on `deploy.mode none`: the factory deploys and verifies nothing for
  it, however good its Makefile is. That is why a green verify alone does not clear a repo.
- **vps** passes `make verify` only because nothing is recorded as deployed; the Issue asks for a verify that proves something.
- **Dirty or stale main checkouts** seen on the day, none touched here: `hermes-agent` and `modelpick` each have uncommitted
  files; `agent-workflows` is 4 and `iris` 8 commits behind `origin/master`. A lead working there has to expect it.
- **argo** is the only repo with a manifest and a red verify. It blocks the hold of every argo Issue until its Issue lands.
