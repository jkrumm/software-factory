# Package 6: Checkpoints

**Where the factory stops for a person: Decisions with their required fields and worth-asking, the ledger, artifacts
with revisions, annotations and verdicts, errands, and the owner's line.** A Decision is settled by standing policy,
then the Judge, then a default after a wait when the option is reversible, then the owner. Branch
`rw/6-checkpoints`. Review: deep.

Read `docs/rewrite/briefs/parallel.md` first: its rules hold here and are not repeated.

## Port from

`docs/architecture.md` §Loops and agw (the Decision path, the owner's line), §The Console (Artifacts: Markdown or
HTML, revisions, anchors as quote plus path, "Unanchored"), §Data (blobs under the data directory, never in git);
`docs/language.md` "Where the owner comes in" (every word there); `docs/product.md` (the position, jobs 1 and 3);
decisions NL8, NL17, NL20 (ntfy carries checkpoints only), RS3, RS12; `docs/design.md` §4 "The ask judge", §11 "Asks
versus health lines", "The owner's line"; `legacy/server/src/issues/{decisions,inbox,attention,judge,judge-input}.ts`,
`legacy/server/src/notify/`.

## Yours

`domains/checkpoints/`, `app/checkpoints*.ts`, `adapters/ntfy/`, `adapters/blobs/` (artifact revisions under the
factory's data directory), `api/checkpoints.ts`, `packages/contract/src/checkpoints.ts`, migrations `0600`+.

## Build

1. **Decisions:** `factory issue ask` (the lead's verb) raises one with the required fields: recommendation, what was
   checked, cost per option, what happens with no answer, options marked reversible or not. A Decision missing a
   field is refused with the field named. It records `asked`; an answer records `answered` (report 1). Worth-asking is
   the owner's flag on an answered Decision.
2. **Settling, in turn:** standing policy in `project.yaml` (read through a port; package 3 owns the project), the
   lead's own fields, the **Judge** through an agw port (a fake here: precedent lookup in Postgres text search is
   yours, the `factory-ask` workflow call is package 7's), the default after its wait when the option is reversible,
   then the owner. Each step records who settled it.
3. **The ledger:** every Decision with its path to the answer and the worth-asking flag, readable for the Judge's
   precedent and later the KPIs.
4. **Artifacts:** one model, four kinds (Concept, Spec, Decision, Report); revisions stored as blobs; annotations
   anchored by quote plus path with an "Unanchored" fallback; verdicts (Looks good, With notes, Changes, No longer
   applies). A Concept or Spec handed over records `submitted`, its verdict `verdict_given`, which reaches the lead as
   its next turn through the machine's `note_lead`. A Report never waits.
5. **Errands:** raised by the lead (`errand_raised`), done by the owner (`errand_done`); no separate human queue.
6. **The owner's line:** ntfy carries checkpoints only, through an outbox of its own with deterministic keys, so a
   replay never pages twice; a deep link per checkpoint (a placeholder base URL setting until the Console exists).
   Work the factory settles never pages.

## Acceptance

- Scenario: a verdict on a submitted Spec arrives as the lead's next turn (one `note_lead`, once).
- Scenario: one Decision settled by policy; one by the Judge (fake agw); one by its default after the wait; one by the
  owner, paging him once and only for that one.
- Scenarios for: a Decision missing a field is refused; an errand raised and done; an annotation whose quote is gone
  lands in "Unanchored"; a replayed ntfy outbox pages once.

## Out of scope

The `factory-ask` workflow and the Judge loop's tick (package 7). The Console's artifact page (after the cutover).
Cancel as an owner verb (package 8).
