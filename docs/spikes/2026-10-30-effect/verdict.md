# Verdict: plain TypeScript

**The factory is written in plain TypeScript and zod.** Effect passed two of the three pre-written conditions and failed
the third by a wide margin: its worker used 3.94× the plain worker's tokens against a limit of 1.5×. The rule in
`spec.md` was fixed before either arm ran and is applied as written.

| Condition | Plain (`spike/plain` `bbd5cbd`) | Effect (`spike/effect` `1e9ff26`) | Pass |
|-|-|-|-|
| Review findings ≤ plain's (`/code-review high`, all verified findings) | 10 | 10 | yes |
| No v3-API mistake in the final diff | n/a | 0: `tsc` green with `@effect/tsgo`, no cast, `any`, `Date.now` or `runPromise` in `src/` and `test/` | yes |
| Worker tokens ≤ 1.5× plain's | 1,220,381 | 4,807,457 (3.94×) | **no** |

| Other numbers | Plain | Effect | Ratio |
|-|-|-|-|
| Output tokens | 35,972 | 67,329 | 1.87× |
| Cache writes | 66,328 | 142,051 | 2.14× |
| Cache reads | 1,118,039 | 4,597,989 | 4.11× |
| Lines in `src`, `test`, `migrations` | 1,238 | 1,272 | 1.03× |
| Tests, all green on a re-run | 39 | 29 | |

Both arms ran Sonnet at the default effort, from the same spec, with no steering. Every token count comes from one
transcript per arm, deduplicated by message id; neither worker used a subagent.

**Reading the result.** Every token measure fails, so the conclusion does not depend on how tokens are weighed.
Output tokens alone are 1.87×. Some of the gap is first-contact cost: the worker had to read `node_modules` to find a
v4 API, and that reading lands in cache for every later turn. Later work would cost less, but the arm that was
measured is the one the rule judges, and agents start each session without that knowledge. The skill and `@effect/tsgo` did
what they were built for: a model with stale memory produced correct v4 code on the first pass. Quality was equal, not
better, so the extra spend bought nothing the review could see.

Version caveat: both ran before `effect@4.1.0` cleared the release-age cooldown, on 4.0.6. Nothing in the slice touches
what 4.1.0 changed.

## What both arms got wrong

The review found the same design mistakes in both. They come from the spec, not the language, so they went into
`docs/design.md` §3:

- The `Runner` call and its retries ran inside the transaction holding the row lock, with no timeout on the process. One
  hung `herdr` stalls the tick for good.
- A spawn's account was chosen once and not rechecked at start, so a stale choice lands on an exhausted account.
- `attempts` was recorded and never read, so a transient failure retried forever.
- One bad spawn could occupy the whole batch and starve the rest.

## Afterwards

`spike/plain` is the base for the skeleton (F0 step 4), with its findings fixed; it is not merged as it stands.
`spike/effect` stays on the remote for reference. The Effect skill is removed from master; `git log` has it.
