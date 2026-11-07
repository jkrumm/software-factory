# Package 5: Quality

**Gates a lead cannot talk past: evidence, the watch after a ship, and verify that ends it.** A review is recorded as
evidence when it exists and never refuses a ship (NL23). You implement the `start_watch` effect port, the lead's
`ship`, regressions and the reopen verb. Branch `rw/5-quality`. Review: standard.

Read `docs/rewrite/briefs/parallel.md` first: its rules hold here and are not repeated.

## Port from

`docs/architecture.md` §The server (quality), §Tests; `docs/language.md` Shipping (Gate, Evidence, Ship, Watch,
Verify, Review); decisions NL9, NL12, NL23, RS7; `docs/design.md` §4 "The evidence gate", "The hold" (now the watch),
"Reopen", §5 "Done means evidence"; `legacy/server/src/issues/{evidence,review,hold,commits,offtick}.ts`,
`scripts/verify.sh` (the make contract `make verify`).

## Yours

`domains/quality/`, `app/quality*.ts`, `adapters/quality/` (git for merged commits, `make verify` and probes run off
the tick with a process timeout), `api/quality.ts`, `packages/contract/src/quality.ts`, migrations `0500`+.

## Build

1. **Evidence:** `ship` names its merged commits; they are checked outside any transaction (on the default branch,
   deployed: `make version` holds them) and recorded as evidence. A ship without evidence is refused by the gate with
   the verb's error named. **A review is evidence when it exists** (agw's `covered` for the ship range); its absence
   is recorded, never a refusal (NL23), so the friction loop can count it later.
2. **Ship and watch:** `shipped` (`recordIn`) plans `start_watch`; your port runs the watch window from the project's
   setting, then verify (`make verify`, probes) off the tick, never inside a transaction, and records `watch_passed`
   or `regressed`.
3. **Regression:** a red verify, or a signal that speaks for a watched or closed Issue (intake hands it over through a
   use case you expose), records `regressed`. Report 1 has the counts: twice back to the lead, the third a stall.
4. **Reopen:** the owner's verb within the window (report 1: `reopened`, the only way out of `closed`); after it, a new
   Issue.
5. Fix forward (NL9): no rollback, restore or undo machinery.

## Acceptance

- Scenarios: ship (with evidence; refused without merged commits; accepted without a review, the absence recorded),
  watch (the window, then verify), verify green closes it `done`, a regression sends it back to the lead, the third
  is a stall, reopen within the window and refused after it.

## Out of scope

The review itself (the lead's, NL12). The friction loop's count (after the cutover). Intake's correlation of the
signal (package 2): you expose the use case it calls.
