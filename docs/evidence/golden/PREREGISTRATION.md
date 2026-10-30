# Backtest pre-registration

Committed before any golden-set label existed (2026-10-22, see `git log` of this file).
The backtest (`evidence/golden/backtest.py`, Phase 6) is judged against these thresholds
and nothing else. Changing a threshold after labels exist requires a new dated section
that states why, and the report shows both.

## What is scored

The proposed intake path — fingerprint refinement → topology and time-window
correlation → candidate gate → known-error match → escalation policy — runs over the
golden set's events in time order, seeing only data with `first_seen` ≤ the event's own
time (no look-ahead). Its output per event: incident group, escalate (y/n), known-error
match (incident id or none). The same scoring runs on today's warden behaviour
(its recorded `duplicate_of`/attach links and `needs_decision` transitions) as the
baseline.

## Estimators

- Grouping: entity-centric B-cubed precision and recall (per-element, averaged over
  sampled elements, inverse-probability weighted by the sampling design in
  `sample.out.json`), plus pairwise and cluster metrics for reference only.
- Escalation: precision and recall against `genuine_owner_decision = y`, over escalated
  and non-escalated items alike.
- Uncertain labels: scored both ways (as labelled, and flipped); a threshold passes only
  if it passes under both.

## Thresholds

| Metric | Pass | Baseline must be reported |
|-|-|-|
| B-cubed precision (grouping) | ≥ 0.90 | yes |
| B-cubed recall (grouping) | ≥ 0.80 | yes |
| B-cubed F1 vs today's warden | strictly higher | — |
| Escalation recall (genuine owner decisions escalated) | 1.00 — no genuine decision auto-closed; one miss allowed only if its label is `uncertain` | yes |
| Escalation precision (escalations that are genuine) | ≥ 0.80 | yes |
| Owner-touch share of items, sampling-weighted | ≤ 1 % (long-run target 0.1 %) | yes |
| Known-error match on `known_fix = y` items | ≥ 0.50 matched to the right prior incident | yes |
| Known-error false match on `known_fix = n` items | ≤ 0.05 | yes |

## Not allowed

- Tuning rules on the full golden set. Rules are fitted on a development split (the
  chunks whose index is even) and scored once on the held-out odd chunks; the report
  gives both numbers.
- Dropping events from scoring after seeing results.

## Amendment 2026-10-22 — the join reading for uncertain grouping labels

Thresholds above are unchanged. Why: the panel (pass 1, cor-5) showed the uncertain-label rule
covers one direction only. A grouping-uncertain event is flipped by detaching it into a singleton
(`backtest.py`, `flipped_gold_groups`), which tests "gold over-merged" and never "gold
under-merged"; with 185 uncertain labels (`agreement.out.md`) that is not the worst case, and the
held-out flipped recall rising to 0.881 against 0.846 labelled (`backtest.out.md` §1) is partly
an artefact of shrinking gold groups.

- **Future samples** (the fresh post-cutover sample and every later one) score grouping under
  three readings: *labelled*, *detach* (the existing flip) and *join* — each group-uncertain event
  joins the alternative group its `why_uncertain` names, or, where none is named, the nearest gold
  group in time. A grouping threshold passes only if it passes under all three.
- **The current held-out pass** (`backtest.out.md`, held-out passes recorded: 1) holds under the
  labelled and detach readings only. It is not re-scored under *join*: the held-out is spent.
- `backtest.out.md` and the report show the readings side by side.

## Amendment 2026-10-22 — frame, unit, size and comparator of the fresh sample

Written before any post-cutover label exists. Thresholds above are unchanged, and so are the three
grouping readings of the previous amendment (labelled, detach, join). Why (panel pass 2, cor-6,
cor-7, mig-1): grouping acceptance moved to a fresh post-cutover sample, but its design still took
its unit and its cross-burst joins from warden's entities, which the system under test replaces,
and nothing fixed its frame, size or comparator before data exists. The first sample's unit was an
entity — an item plus its `duplicate_of` children (`sample.out.json`, `design.unit`) — and its
cross-burst joins ran along `entity.peers` (`LABELS.md` §2), warden's own group members, so a split
that grouping itself made stayed invisible.

| Item | Fixed before any label exists |
|-|-|
| Frame | Recorded primary-source history with no blind label: Kuma webhook rows since 2026-10-16, HyperDX alerts, Docker events after `AS_OF` (2026-10-22T08:00:00Z, `sample.out.json`) and the 2026-10-17 burst as its primary-source rows. A row that also sits in the golden set is labelled afresh from a blind packet; its golden label is neither shown nor reused. The frame is listed by id, and the draw script and seed are committed, before the first packet is cut. |
| Sampling unit | A time window, stratified by source × host. A window is 30 minutes: the burst gap of the chunking (`chunks/index.json`, `params.burst_gap_min`) and the context window of the first sample (`sample.out.json`). Elements are the signals in the sampled windows; weights are the inverse inclusion probability of this design. No warden item, entity, `duplicate_of` link or correlator output enters the design. |
| Size | ≥ 400 sampled elements. The first sample drew 404 across all 21 chunks and 208 in the held-out half that carried the grouping pass, whose precision interval [0.893, 0.970] straddles its threshold (`backtest.out.md` §1, §4); at the same per-element variance the 95 % half-width falls from 0.0385 to ≈ 0.028 at 400 (0.0385 × √(208 / 400)). Grouping acceptance (W3) is scored once the draw holds 400 elements. The draw then extends window by window under the same strata for the escalation and known-error tests, which run once ≥ 30 decision candidates are labelled — elements whose `genuine_owner_decision` is `y` under the labelled or the flipped reading (the first sample held 6 of 959, `agreement.out.md`). Until then they are reported as not measured, never as passed. |
| Packets | Blind: `id`, `source`, `external_id`, `title`, `payload`, source time, and the topology subject with its ancestors. No `entity`, `item`, `escalation`, `transitions`, `dispatches`, `fix_commits`, `neighbours` or `pre_*` field. Hinted packets (today's fields) are a second reading, reported beside, never instead of. |
| Cross-burst gold | A blind labeller searches ±7 d around each element for the same subject, the same topology ancestor or the same fingerprint and joins the groups; never along `entity.peers`, and not limited to adjacent chunks. Events the search finds are labelled as context and are never elements. |
| Comparator | Old warden's recorded grouping of the same signals, read from the archive taken at the stop: its `duplicate_of` and attach links and its `needs_decision` transitions, as in *What is scored*. A signal old warden never ingested, such as a Docker event after `AS_OF`, is a singleton there, as before the ledger in the held-out era split (`backtest.out.md` §4). F1 "strictly higher" is judged against it. |
| Correlator scored | The build that passes W3 gate (a), the fixture regression against `backtest.py` v2's frozen output (pass 2, cor-1). Its parameters are not refitted on this sample, and *Not allowed* above applies. |
| Reported beside every grouping number | B-cubed precision and recall over non-noise gold groups; the hidden-incident rate, the weighted share of non-noise gold groups whose events all sit inside a predicted group dominated by a different gold group; and the count of multi-signal gold groups with the share of elements in them, so a sample of mostly singletons shows as one. No threshold attaches to these. |
