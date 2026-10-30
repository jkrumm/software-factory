# __NAME__: a number module with a long Wave 2
**Goal:** `src/num.ts` exports `clamp`, then the eight functions of Wave 2, then `sign` and `sum`, each with tests in `src/num.test.ts`.
**Gate:** `make check` passes before the close-out commit.

## Wave 1 — clamp            <!-- status: active -->
- [ ] Add `clamp(value: number, min: number, max: number): number` to `src/num.ts`: `value` limited to `[min, max]`.
- [ ] Add tests for it to `src/num.test.ts` (below, inside, above, min equal to max).
- [ ] Run `make check`, commit, update this plan, commit, push, then spawn the next wave with `rd wave __NAME__ 'Read docs/waves/PLAN.md. Execute the active wave (Wave 2). Follow the /wave skill.'`
**Left behind:**

## Wave 2 — eight functions, one commit each            <!-- status: pending -->
This wave is deliberately long. Work the steps in order, one after the other; for each step add the function to `src/num.ts`,
its tests to `src/num.test.ts`, run `make check`, and make **one commit per step** (`feat: <name>`). Do not batch steps and do
not skip ahead. Tests of each function cover at least five cases (edge cases, negatives, empty input, large values, order).
- [ ] 1. `lerp(a, b, t)`: `a + (b - a) * t`, `t` not limited.
- [ ] 2. `inverseLerp(a, b, v)`: where `v` lies between `a` and `b` as a fraction, `NaN` when `a === b`.
- [ ] 3. `remap(v, inMin, inMax, outMin, outMax)`: `inverseLerp` into `lerp`; reuse both functions.
- [ ] 4. `mean(values: number[])`: the arithmetic mean, `NaN` for an empty list.
- [ ] 5. `median(values: number[])`: the middle value, the mean of the two middle values for an even count, `NaN` for an empty list; the input is not mutated.
- [ ] 6. `variance(values: number[])`: the population variance, `NaN` for an empty list; reuse `mean`.
- [ ] 7. `stddev(values: number[])`: the square root of `variance`.
- [ ] 8. `percentile(values: number[], p: number)`: linear interpolation between closest ranks, `p` in `[0, 100]` (clamp it with `clamp`), `NaN` for an empty list; the input is not mutated.
- [ ] 9. Document all nine exported functions in a table in `README.md` (name, signature, one-line behaviour), commit as `docs: function table`.
- [ ] 10. Run `make check`, update this plan, commit, push, then run `rd wave __NAME__ 'Read docs/waves/PLAN.md. Execute the active wave (Wave 3). Follow the /wave skill.'`
**Left behind:**

## Wave 3 — sign            <!-- status: pending -->
- [ ] Add `sign(value: number): -1 | 0 | 1` to `src/num.ts` and tests to `src/num.test.ts` (negative, zero, positive, `-0`).
- [ ] Run `make check`, commit, update this plan, commit, push, then run `rd wave __NAME__ 'Read docs/waves/PLAN.md. Execute the active wave (Wave 4). Follow the /wave skill.'`
**Left behind:**

## Wave 4 — sum            <!-- status: pending -->
- [ ] Add `sum(values: number[]): number` to `src/num.ts` and tests to `src/num.test.ts` (empty list is 0, negatives, one value).
- [ ] Run `make check`, commit, update this plan (this wave `done`, Left behind "chain complete"), commit, push. Spawn nothing.
**Left behind:**
