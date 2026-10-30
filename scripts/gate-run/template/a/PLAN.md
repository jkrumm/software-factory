# factory-gate-a: a tiny text module
**Goal:** `src/text.ts` exports `slugify`, `truncate`, `wordCount` and `titleCase`, each with tests in `src/text.test.ts`.
**Gate:** `make check` passes before the close-out commit.

## Wave 1 — slugify            <!-- status: active -->
- [ ] Add `slugify(input: string): string` to `src/text.ts`: lowercase, every run of non-alphanumerics becomes one `-`, no leading or trailing `-`.
- [ ] Add tests for it to `src/text.test.ts` (spaces, punctuation, empty string).
- [ ] Run `make check`, commit, update this plan, commit, push, then spawn the next wave with `rd wave factory-gate-a 'Read docs/waves/PLAN.md. Execute the active wave (Wave 2). Follow the /wave skill.'`
**Left behind:**

## Wave 2 — truncate            <!-- status: pending -->
- [ ] Add `truncate(input: string, max: number): string` to `src/text.ts`: input unchanged when it fits, otherwise cut to `max - 1` characters plus `…`.
- [ ] Add tests for it to `src/text.test.ts` (fits, cut, max of 1, empty string).
- [ ] Run `make check`, commit, update this plan, commit, push, then run `rd wave factory-gate-a 'Read docs/waves/PLAN.md. Execute the active wave (Wave 3). Follow the /wave skill.'`
**Left behind:**

## Wave 3 — wordCount            <!-- status: pending -->
- [ ] Add `wordCount(input: string): number` to `src/text.ts`: words are runs of non-whitespace characters.
- [ ] Add tests for it to `src/text.test.ts` (several spaces, tabs and newlines, empty string).
- [ ] Run `make check`, commit, update this plan, commit, push, then run `rd wave factory-gate-a 'Read docs/waves/PLAN.md. Execute the active wave (Wave 4). Follow the /wave skill.'`
**Left behind:**

## Wave 4 — titleCase            <!-- status: pending -->
- [ ] Add `titleCase(input: string): string` to `src/text.ts`: the first letter of every word upper case, the rest lower case.
- [ ] Add tests for it to `src/text.test.ts` (mixed case, several spaces, empty string).
- [ ] Run `make check`, commit, update this plan (this wave `done`, Left behind "chain complete"), commit, push. Spawn nothing.
**Left behind:**
