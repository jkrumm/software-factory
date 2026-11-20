# Review POC, 2026-11-04

**Verdict:** the bridge works on Max with no API spend. The lead's session runs `agw review prepare`, copies the seat into
the `reviewer` subagent call, submits the reply. The router change (agw `6cb7961`, deployed) removed the worst
over-routing; deep found the only real bug in six reviews; one light reviewer misbehaved and got a rule.

## Router before and after

| Commit | Before | After |
|-|-|-|
| `c39f76b` strategy HTML under `docs/` | deep: "15481 changed non-test code lines" | none: docs only |
| `07f2f7b` 13-line test fix | light, Sonnet low | light, Sonnet medium |
| `4bdc4b8` cancel 409 field in `http.ts` | deep, 3-vote | deep, one verifier |

Over the last 28 commits of software-factory and agent-workflows the new router gives none 6, light 10, standard 5,
deep 9. Deep is still 32 %, almost all from REVIEW.md sensitive paths; the sensitive lists are the next lever.

## Six reviews

Tokens are the subagent's own (Sonnet 5.5), cache read / cache write / output. Model and effort were confirmed from the
subagent's metadata (`"model":"sonnet","effort":…`) and transcript (`claude-sonnet-5-5`).

| Commit | Tier, seat | Size | Result | Tokens | Time |
|-|-|-|-|-|-|
| `07f2f7b` | light, Sonnet low (old seat) | 13 test lines | clean | 21k / 24k / 0.3k | 5 s |
| `89baa86` | standard, Sonnet medium | 153 lines | clean | 79k / 32k / 2.9k | 19 s |
| `e03aee0` | light, Sonnet medium | 27 lines | 1 nit: README tier rows miss the new routes | 151k / 18k / 3.5k | 23 s |
| `6cb7961` | standard, Sonnet medium | 55 lines | clean (the router change reviewed itself) | 199k / 33k / 4.3k | 38 s |
| `7aa9e4f` | light, Sonnet medium | 15 lines | clean; spawned two "noop" Explore agents and replied in prose after the JSON | 411k / 50k / 6.1k | 59 s |
| `7b16632` | deep, Sonnet high + 1 verifier | 65 lines, sensitive | **1 important, verified:** migration 029 was edited after it was applied, so the live CHECK rejects `walled` | 865k / 107k / 17.3k | 105 s |

## What changed because of it

- `reviewer.md`: the Agent tool is for `review-verifier` at tier deep only (dotfiles `d991ef0`).
- `reviewer.md`, `review-verifier.md`: one verifier per important finding, `omitClaudeMd: true` (dotfiles `854b82c`).
- The deep finding is real (`git log` shows 029 edited in `84b5de1` and `7b16632` after `68125a0` created it). It lives in
  the review transport that design v3 deletes (row 8); until then the live server logs a check violation when a reviewer
  is walled.

## Next

- Measure acted-on rate per tier from the dispositions once leads use it (design v3 §11).
- Trim REVIEW.md sensitive lists to the files where a small change can break the trust boundary or the data.
