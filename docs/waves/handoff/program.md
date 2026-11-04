# Program lead handoff: the reset

Written 2026-11-05 ~00:00 by the planning session (t14) that ran the owner's re-plan. You are the program lead for the reset:
`PLAN.md` Wave 8, track plan `docs/waves/reset.md`. The owner is asleep and reads `learnings.md` and this file in the morning.
The previous handoff (FV) is in git history.

## Read first

1. `docs/decisions.md` RS1–RS9: what the owner decided tonight.
2. `docs/strategy/2026-11-reset/design-v3.md`: the design. §13 is the build order, §14 what the adversarial review changed.
3. `docs/strategy/2026-11-reset/review-poc.md`: how review runs now (it is the flow you use for every wave).
4. `docs/strategy/2026-11-reset/learnings.md`: what already fell apart; add to it.

## Done tonight (verified)

| What | Where | Proof |
|-|-|-|
| Review router: docs-only → none, light seat Sonnet medium, deep one verifier | agw `6cb7961`, deployed | `make deploy` OK, six reviews in `review-poc.md` |
| Reviewer agents: one verifier, `omitClaudeMd`, Agent tool only at deep | dotfiles `854b82c`, `d991ef0` | used for every review since |
| Step 0: no false failure for a live terminal, Enter-only retry only after a confirmed typing (`prompts.typed_at`, migration 030), machine failures not asks, factory asks expire after 7 days | `7b0cb25`..`0c2e777`, deployed | `make verify` all passed; asks 13 → 9; deep review 2 rounds, `covered` true |
| Tag `pre-reset-2026-11` | software-factory, dotfiles, agent-workflows | `git tag` |
| History page | brain `6fcef42` | `wiki/engineering/software-factory-history.md` |

## Running now (not yours to drive)

| Agent | What | Note |
|-|-|-|
| `iris-w21-lead` (t127) and workers t12g, t12k | iris Wave 21 | asked to start no `xcodebuild`/simulator run until 07:00; it waits on a timer to 07:02. Its input line holds an unsubmitted "run the A1 and P1 validation now": leave it, the owner decides |
| t11q (agent-workflows) | gateway plan, review lanes for PRs 83/133/134 | not part of the reset |
| IuRoot sessions | read-only for the factory | never touch |

## The asks right now (9)

Decisions: Issue 49 (one tailnet port for KoInsight → Argo, a security call), the MacBook herdr-core stuck after 0.1.17.
Owner's stale: WeatherOrb iPhone (20 days), Wave 8 cutover (3 days). Machine leftovers that expire by 2026-11-09: the two failed
spawns `agent-workflows-seats-on-claude`/`-gateway-opencode`, review `rv_kmnj…` needing a human. `hc:t126` (IuRoot permission
prompt). `iris-w21-lead` waiting on the owner (the pause). Do not answer the owner's decisions; record the count after Wave 5.

## Known sharp edges

- `/review --scope HEAD` reviews nothing; use `head` or an explicit `a..b` range.
- Coverage is per commit: a fix commit after round 2 needs its own (light) review before `covered` is true.
- `make check` under load fails tests by timeout; rerun the failing file alone before calling it red.
- `factory issue stop` drops an Issue (outcome `dropped`); that is the intended cutover for 51–55.
- The live database rejects review outcome `walled` (migration 029 was edited after it was applied). It dies with the review
  transport in a later row; do not fix it in this run.
- dotfiles `make check` is red on unmapped launchd labels (`home-nacht`, `athena-repo-sync`, `soloist-speaker`) from other
  sessions: not yours; land dotfiles changes with the failure named in the merge note.

## Start

```sh
rd wave --role lead software-factory 'Read docs/waves/PLAN.md. Execute the active wave (Wave 8). Read docs/waves/handoff/program.md first. Follow the /wave skill.'
```
