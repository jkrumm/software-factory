# Backtest: proposed intake path, Keep-style correlator and today's warden

Rendered by `backtest.py` (no hand edits). Binding inputs: `PREREGISTRATION.md` (thresholds unchanged), `LABELS.md`, `sample.out.json`, `chunks/`, `labels/`, `../signals/topology.out.json`, the frozen warden snapshot (rows dated before each event only).

- Script sha256 at freeze: `78a7b5b4e3a08d0c8e51104819452cc167f522d0e341ff12540c136c75624022`; pre-registration sha256: `3f142e52638e718659f7486e67d19836b601549b112ddf93b07adfaa69509ea7`.
- Order of operations: parameters fitted on the even (development) chunks only, the freeze record written to `backtest.out.json`, then the odd (held-out) chunks read and scored. Held-out passes recorded for this output: 1.
- Replay: events sorted by `occurred_at` (message time where the packet gives one, host-local log time converted for Hermes log lines), each step sees only earlier events and history rows dated before the event.
- Disclosure: Before the first rule was written the author listed ids, titles and label notes of the genuine=y and known_fix=y events and the `why_uncertain` texts of both splits to size the problem. Rules, windows and the escalation evidence tables were then designed and revised from the development chunks only; no held-out packet was read for design, and nothing seen in that listing was used to tune a rule. Revisions made while looking at development errors are listed in the development log.
- Estimators: B-cubed weighted by `sample.weight` over sampled elements (context events are labelled but are never elements); pairwise and cluster metrics are reference only. `labelled / flipped`: every uncertain label read as written / flipped (grouping: an event whose uncertainty names its group detaches into a singleton; genuine and known_fix: the flagged label inverts).
- How each threshold is computed: B-cubed over sampled elements with predicted groups restricted to the split; escalation recall counts every labelled event (a genuine decision that is not escalated is a miss wherever it sits), escalation precision is weighted over sampled elements; owner-touch share is the weighted share of sampled events the system escalates (today's warden: DEFINITIONS `owner_touch`); known-error match is top-1 against `known_fix_ref` (an item id or a commit prefix of the matched prior) over sampled known_fix=y events, false match is any match on sampled known_fix=n events; today's warden matches through `closed:fixed_by #N`, Keep-style has no known errors and, having no decision policy, runs the proposal's escalation module.

## 1. Verdict on the held-out split (odd chunks, scored once)

| Metric (pre-registered rule) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision (grouping): >= 0.90 | 0.937 (flipped 0.902) PASS | 0.993 (flipped 0.990) PASS | 0.968 (flipped 0.965) PASS |
| B-cubed recall (grouping): >= 0.80 | 0.846 (flipped 0.881) PASS | 0.595 (flipped 0.648) FAIL | 0.595 (flipped 0.651) FAIL |
| B-cubed F1 vs today's warden: strictly above today's warden | 0.889 (flipped 0.891) PASS | 0.744 (flipped 0.783) reference | 0.737 (flipped 0.777) FAIL |
| Escalation recall (genuine owner decisions escalated): 1.00, no genuine decision auto-closed (one miss only if its label is uncertain) | 0/1 caught (flipped 0/7) FAIL (labelled PASS, flipped FAIL) | 0/1 caught (flipped 6/7) FAIL (labelled PASS, flipped FAIL) | 0/1 caught (flipped 0/7) FAIL (labelled PASS, flipped FAIL) |
| Escalation precision (escalations that are genuine): >= 0.80 | 0.000 (flipped 0.000) of 4 escalated FAIL | 0.000 (flipped 0.105) of 57 escalated FAIL | 0.000 (flipped 0.000) of 4 escalated FAIL |
| Owner-touch share of items, sampling-weighted: <= 1 % (long-run 0.1 %) | 0.62 % PASS | 14.09 % FAIL | 0.62 % PASS |
| Known-error match on known_fix=y, matched to the right prior: >= 0.50 to the right prior incident | 0.479 (flipped 0.222), 1/5 sampled FAIL | 0.000 (flipped 0.000), 0/5 sampled FAIL | 0.000 (flipped 0.000), 0/5 sampled FAIL |
| Known-error false match on known_fix=n: <= 0.05 | 0.007 (flipped 0.007), 6/203 sampled PASS | 0.000 (flipped 0.000), 0/203 sampled PASS | 0.000 (flipped 0.000), 0/203 sampled PASS |

Held-out: 484 events, 208 sampled elements, 1 genuine owner decision(s), 9 known_fix=y events (5 sampled). Owner-touch oracle (escalate exactly the labelled genuine decisions): 0.60 %.

## 2. The same table on the development split (even chunks, where the parameters were fitted)

| Metric (pre-registered rule) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision (grouping): >= 0.90 | 0.990 (flipped 0.927) PASS | 0.998 (flipped 0.998) PASS | 0.913 (flipped 0.904) PASS |
| B-cubed recall (grouping): >= 0.80 | 0.887 (flipped 0.921) PASS | 0.577 (flipped 0.652) FAIL | 0.607 (flipped 0.676) FAIL |
| B-cubed F1 vs today's warden: strictly above today's warden | 0.936 (flipped 0.924) PASS | 0.731 (flipped 0.789) reference | 0.729 (flipped 0.774) FAIL |
| Escalation recall (genuine owner decisions escalated): 1.00, no genuine decision auto-closed (one miss only if its label is uncertain) | 5/5 caught (flipped 2/7) FAIL (labelled PASS, flipped FAIL) | 4/5 caught (flipped 4/7) FAIL (labelled PASS, flipped FAIL) | 5/5 caught (flipped 2/7) FAIL (labelled PASS, flipped FAIL) |
| Escalation precision (escalations that are genuine): >= 0.80 | 1.000 (flipped 0.190) of 5 escalated FAIL (labelled PASS, flipped FAIL) | 0.083 (flipped 0.083) of 48 escalated FAIL | 1.000 (flipped 0.190) of 5 escalated FAIL (labelled PASS, flipped FAIL) |
| Owner-touch share of items, sampling-weighted: <= 1 % (long-run 0.1 %) | 1.29 % FAIL | 16.55 % FAIL | 1.29 % FAIL |
| Known-error match on known_fix=y, matched to the right prior: >= 0.50 to the right prior incident | 0.496 (flipped 0.430), 4/7 sampled FAIL | 0.125 (flipped 0.000), 1/7 sampled FAIL | 0.000 (flipped 0.000), 0/7 sampled FAIL |
| Known-error false match on known_fix=n: <= 0.05 | 0.015 (flipped 0.026), 8/189 sampled PASS | 0.000 (flipped 0.004), 0/189 sampled PASS | 0.000 (flipped 0.000), 0/189 sampled PASS |

Development: 475 events, 196 sampled elements, 5 genuine decisions, 11 known_fix=y. Owner-touch oracle: 1.29 % (labelled), 0.49 % (flipped).

## 3. Frozen parameters

| Parameter | Value | Grid | Meaning |
|-|-|-|-|
| proposed.w_topo | 45 | [5, 10, 20, 45, 90, 180] | topology fold window (service, project, host, Kuma tree), minutes |
| proposed.k_host | 2 | [2, 3, 4] | distinct infrastructure subjects before a host fold |
| proposed.w_dedup | 720 | [30, 180, 720, 2880] | same refined fingerprint, stateless sources, minutes |
| proposed.w_open | 360 | [60, 360, 1440] | firing repeated with no Up seen: same incident within, minutes |
| proposed.w_rec | 10080 | [1440, 10080] | look-back that pairs an Up with its Down, minutes |
| proposed.w_reopen | 10 | [0, 10, 30] | re-fire after an Up rejoins the group within, minutes (flap) |
| proposed.w_chat | 30 | [10, 30, 90, 360] | consecutive chat messages, minutes |
| proposed.th_sim | 0.2 | [0.2, 0.34, 0.5, 0.7] | ticket/brief title similarity (Jaccard, at least 2 shared tokens) |
| proposed.w_sim | 240 | [30, 240, 1440] | ... within, minutes |
| known_error.theta | 0.9 | [0.5, 0.6, 0.7, 0.8, 0.9] | token-similarity fallback after an exact fingerprint miss (store: 208 closed incidents with a recipe from 560 ledger items) |
| gate.T / gate.N | 30 / 1 | {'T': [0, 5, 15, 30], 'N': [1, 2, 3]} | candidate persists >= T minutes or holds >= N signals or matches a known error |
| keep.w_dedup | 1 | [1, 5, 30, 180, 720, 4320] | Keep-style: partial-dedup window on (source, normalised title), minutes |
| keep.w_corr | 30 | [1, 2, 5, 10, 30, 60, 180] | Keep-style: 'same service or host' correlation window, minutes |
| keep.gate_n | 4 | [1, 2, 3, 4] | Keep-style: alerts a correlated group needs to become an incident (candidate gate) |
| keep_tag (ablation only) | {"w_dedup": 720, "w_corr": 1, "gate_n": 3, "tag_aware": true} | same grid | Keep-style variant whose fingerprint also carries the release tag, refitted on dev |

Fit objective (development only): B-cubed F1 with precision >= 0.90 preferred, coordinate descent over the grid from the stated defaults; Keep-style: full grid, same objective; known-error theta: highest recall with false match <= 0.05, ties to the higher threshold; gate: weighted F1 of 'promoted' against 'gold group is not noise'. Development log of rule revisions made while looking at dev errors:

- occurred_at: first version took the Slack message time nearest first_seen in absolute terms; dev showed recurring rows carrying a later msg_last from another episode, so a message time now counts only when it precedes first_seen by a poll lag.
- R1: a firing repeated with no Up seen was linked for up to 24 h; dev showed two incidents of one monitor a day apart merging through a missing Up, so the open-incident gap is fitted separately (w_open) and a uk row's own resolved_at counts as its Up.
- occurred_at, Hermes log lines: a log_at more than 3 h before first_seen is the stale first_line of an earlier episode of a reused row (dev: one row, 14 days), so first_seen is used; a log_at after first_seen is a later fire and is kept.
- R7: two briefs about different warden items shared template words and merged; briefs with different explicit item references no longer link by title similarity.
- Known-error store: an item was skipped when its final `duplicate_of` was set, which is knowledge from after the event; the filter was removed (a closure only counts when it carries a recipe).
- Escalation and the candidate gate: first version suppressed escalation for candidate groups the gate had not promoted; with the gate fitted to N=1 that coupled grouping parameters to escalation outcomes of the Keep-style baseline, so escalation is now the policy alone and the gate is reported separately.
- Grids: PARAM_GRID was widened once (w_topo to 180, w_dedup to 2880, w_chat to 360, th_sim to 0.2) because the first optimum sat on the edge; KEEP_GRID was widened the same way, down to 1 minute.
- Escalation evidence: first version listed single words ('budget', 'cost', 'scope', 'prune'); the dev positive about a drain 'budget' matched for the wrong reason, so single ambiguous words were replaced by phrases that name the owner-class act.

## 4. Reference metrics, held-out

| Reference metric (labelled view) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision, weighted (95 % CI) | 0.937 [0.893, 0.970] | 0.993 [0.980, 1.000] | 0.968 [0.935, 0.991] |
| B-cubed recall, weighted (95 % CI) | 0.846 [0.797, 0.890] | 0.595 [0.530, 0.659] | 0.595 [0.527, 0.660] |
| B-cubed F1, weighted (95 % CI) | 0.889 [0.854, 0.925] | 0.744 [0.692, 0.793] | 0.737 [0.686, 0.785] |
| F1 minus warden's F1 (95 % CI) | +0.145 [+0.098, +0.194] | - | -0.007 [-0.018, +0.003] |
| B-cubed P / R, unweighted | 0.936 / 0.793 | 0.971 / 0.653 | 0.963 / 0.648 |
| Pairwise P / R / F1 (all events) | 0.901 / 0.583 / 0.708 | 0.346 / 0.005 / 0.011 | 0.495 / 0.029 / 0.054 |
| Cluster P / R (exact groups) | 0.625 / 0.778 | 0.341 / 0.645 | 0.344 / 0.609 |
| Groups predicted / gold | 309 / 248 | 469 / 248 | 439 / 248 |
| Escalation precision / recall, all events (raw) | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |
| Escalations (sampled / all), genuine caught | 2 / 4, 0 of 1 | 57 / 57, 0 of 1 | 2 / 4, 0 of 1 |
| Known-error match in the top three candidates, weighted | 0.479 (1/5) | 0.000 (0/5) | 0.000 (0/5) |
| Known-error match, unweighted all events | 0.222 of 9 | 0.000 of 9 | 0.000 of 9 |
| Known-error false match, unweighted all events | 0.015 of 475 | 0.000 of 475 | 0.000 of 475 |
| Owner-touch share, weighted (95 % CI) | 0.62 % [0.00 %, 1.88 %] | 14.09 % [10.08 %, 19.37 %] | 0.62 % [0.00 %, 1.88 %] |
| Owner-touch events (sampled / all) | 2 / 4 | 76 / 94 | 2 / 4 |

Era split (held-out): today's warden has no ledger before chunk 09, so before it every event is a group of one.

| Era (chunks) | Elements | Proposed P / R / F1 | Today's warden P / R / F1 | Keep-style P / R / F1 |
|-|-|-|-|-|
| before the ledger (chunks 01-08) | 43 | 0.910 / 0.818 / 0.862 | 1.000 / 0.480 / 0.649 | 0.988 / 0.481 / 0.647 |
| ledgered (chunks 09-21) | 165 | 0.954 / 0.864 / 0.907 | 0.989 / 0.667 / 0.797 | 0.955 / 0.668 / 0.786 |

Owner pages on held-out (counts): today's warden escalated 57 items (57 entities); folding those same escalations by the proposed groups gives 51 pages; the proposed policy escalates 4.

### Reference metrics, development split

| Reference metric (labelled view) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision, weighted (95 % CI) | 0.990 [0.976, 0.999] | 0.998 [0.995, 1.000] | 0.913 [0.853, 0.969] |
| B-cubed recall, weighted (95 % CI) | 0.887 [0.845, 0.920] | 0.577 [0.502, 0.657] | 0.607 [0.531, 0.679] |
| B-cubed F1, weighted (95 % CI) | 0.936 [0.911, 0.955] | 0.731 [0.668, 0.793] | 0.729 [0.676, 0.783] |
| F1 minus warden's F1 (95 % CI) | +0.204 [+0.151, +0.260] | - | -0.002 [-0.027, +0.025] |
| B-cubed P / R, unweighted | 0.984 / 0.862 | 0.993 / 0.494 | 0.958 / 0.521 |
| Pairwise P / R / F1 (all events) | 0.989 / 0.797 / 0.882 | 0.944 / 0.010 / 0.020 | 0.350 / 0.031 / 0.058 |
| Cluster P / R (exact groups) | 0.771 / 0.881 | 0.309 / 0.667 | 0.297 / 0.543 |
| Groups predicted / gold | 240 / 210 | 453 / 210 | 384 / 210 |
| Escalation precision / recall, all events (raw) | 1.000 / 1.000 | 0.083 / 0.800 | 1.000 / 1.000 |
| Escalations (sampled / all), genuine caught | 5 / 5, 5 of 5 | 48 / 48, 4 of 5 | 5 / 5, 5 of 5 |
| Known-error match in the top three candidates, weighted | 0.496 (4/7) | 0.125 (1/7) | 0.000 (0/7) |
| Known-error match, unweighted all events | 0.455 of 11 | 0.091 of 11 | 0.000 of 11 |
| Known-error false match, unweighted all events | 0.019 of 464 | 0.000 of 464 | 0.000 of 464 |
| Owner-touch share, weighted (95 % CI) | 1.29 % [0.12 %, 3.03 %] | 16.55 % [11.20 %, 22.59 %] | 1.29 % [0.12 %, 3.03 %] |
| Owner-touch events (sampled / all) | 5 / 5 | 71 / 95 | 5 / 5 |

### All 21 chunks, frozen parameters (post-freeze, descriptive, one interleaved replay)

| Metric (pre-registered rule) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision (grouping): >= 0.90 | 0.950 (flipped 0.902) PASS | 0.995 (flipped 0.993) PASS | 0.942 (flipped 0.936) PASS |
| B-cubed recall (grouping): >= 0.80 | 0.868 (flipped 0.903) PASS | 0.586 (flipped 0.650) FAIL | 0.601 (flipped 0.663) FAIL |
| B-cubed F1 vs today's warden: strictly above today's warden | 0.907 (flipped 0.903) PASS | 0.738 (flipped 0.786) reference | 0.734 (flipped 0.776) FAIL |
| Escalation recall (genuine owner decisions escalated): 1.00, no genuine decision auto-closed (one miss only if its label is uncertain) | 5/6 caught (flipped 2/14) FAIL (labelled PASS, flipped FAIL) | 4/6 caught (flipped 10/14) FAIL | 5/6 caught (flipped 2/14) FAIL (labelled PASS, flipped FAIL) |
| Escalation precision (escalations that are genuine): >= 0.80 | 0.657 (flipped 0.125) of 9 escalated FAIL | 0.038 (flipped 0.095) of 105 escalated FAIL | 0.657 (flipped 0.125) of 9 escalated FAIL |
| Owner-touch share of items, sampling-weighted: <= 1 % (long-run 0.1 %) | 0.94 % PASS | 15.27 % FAIL | 0.94 % PASS |
| Known-error match on known_fix=y, matched to the right prior: >= 0.50 to the right prior incident | 0.491 (flipped 0.315), 5/12 sampled FAIL | 0.083 (flipped 0.000), 1/12 sampled FAIL | 0.000 (flipped 0.000), 0/12 sampled FAIL |
| Known-error false match on known_fix=n: <= 0.05 | 0.010 (flipped 0.016), 14/392 sampled PASS | 0.000 (flipped 0.002), 0/392 sampled PASS | 0.000 (flipped 0.000), 0/392 sampled PASS |

## 5. Escalation detail

Held-out (events the proposed policy escalates, plus every labelled genuine decision):

| Event | Source | Gold genuine | Uncertain | Warden escalated | Proposed escalates | Policy evidence |
|-|-|-|-|-|-|-|
| 968 (c09) | hermes_log | n | no | no | yes | spend: 'billing' in dispatch_human_summary |
| 969 (c09) | hermes_log | n | no | no | yes | spend: 'billing' in dispatch_human_summary |
| 970 (c09) | hermes_log | n | no | no | yes | spend: 'billing' in dispatch_human_summary |
| 1571 (c17) | human | n | no | yes | yes | data_loss: 'dropping a real blocker, adversary) and ' in question |
| 1626 (c17) | github_go | y | yes: genuine | no | no | no decision question |

Development:

| Event | Source | Gold genuine | Uncertain | Warden escalated | Proposed escalates | Policy evidence |
|-|-|-|-|-|-|-|
| 1260 (c12) | human | y | yes: genuine | no | yes | spend: 'paid' in dispatch_human_summary |
| 1424 (c14) | hermes_log | y | yes: genuine | yes | yes | other_people: 'File/PR the launchd ExitTimeOut-vs-drain' in question |
| 1452 (c14) | human | y | no | yes | yes | spend: 'accept the Max cost' in question |
| 1456 (c14) | github_go | y | no | yes | yes | product: 'stated goal' in question |
| 1540 (c16) | github_go | y | yes: genuine | yes | yes | data_loss: 'pruning old blend rounds or archive' in question |

## 6. Known errors

Held-out:

| Event | Gold known_fix_ref | Uncertain | Proposed top match | Right |
|-|-|-|-|-|
| 1372 (c13, context) | item:1368 | yes | none | no |
| 1373 (c13, context) | item:1368 | yes | none | no |
| 1380 (c13, context) | item:1372;item:1368 | yes | none | no |
| 1381 (c13) | item:1372;item:1368 | yes | none | no |
| 1449 (c17) | item:1458; vps@ebd7907 | no | none | no |
| 1492 (c15) | item:1318;agent-gateway@12fa41b | no | items [1318] shas ['ff01a05'] via fp | yes |
| 1494 (c15, context) | item:1099 | no | items [1099] shas ['89f7001', 'f057e7b'] via fp | yes |
| 1585 (c17) | item:1497; hermes-agent@115d62c | no | none | no |
| 1589 (c17) | weatherorb@9dde7bf | yes | none | no |

False matches on known_fix=n events (all events, proposed): 7: 1->[1], 1623->[1623], 1679->[847], 1545->[1545], 750->[750], 1496->[1496], 543->[543]

Development:

| Event | Gold known_fix_ref | Uncertain | Proposed top match | Right |
|-|-|-|-|-|
| 253 (c20) | item:1170;item:1285 | yes | items [253, 1170] shas ['17a5123'] via fp | yes |
| 787 (c10, context) | basalt-ui@6b46613 | no | none | no |
| 815 (c14) | warden@d9ecd2b | no | items [815] shas ['d9ecd2b'] via fp | yes |
| 847 (c14) | vps@a865d77 | yes | items [847] shas ['e5c2314'] via fp | no |
| 1043 (c10, context) | basalt-ui@6b46613 | no | none | no |
| 1074 (c10) | item:1071;hermes-agent@ead94fa | yes | items [1060] shas ['37c887a'] via fp | no |
| 1079 (c10) | item:1071;hermes-agent@37c887a | no | items [1071] shas ['620683d', 'ead94fa'] via fp | yes |
| 1087 (c12, context) | item:1088; warden@ce657d3 | no | items [1087] shas ['ce657d3'] via fp | yes |
| 1450 (c14, context) | item:1298 | yes | none | no |
| 1451 (c14) | item:1298 | yes | none | no |
| 1538 (c16) | item:1497 | yes | items [1497] shas ['115d62c', '8fe7be4'] via fp | yes |

False matches on known_fix=n events (all events, proposed): 9: 1071->[1061], 1078->[1071], 1114->[1114], 1420->[1114], 1421->[1114], 1422->[1114], 1423->[1114], 875->[875], 310->[310]

## 7. Ablation (descriptive, frozen parameters)

Held-out:

| Variant (frozen parameters) | P / R / F1 labelled | P / R / F1 flipped |
|-|-|-|
| Proposed (full) | 0.937 / 0.846 / 0.889 | 0.902 / 0.881 / 0.891 |
| minus topology (tree, service/project/host folds, relays) | 0.944 / 0.773 / 0.850 | 0.918 / 0.818 / 0.866 |
| minus per-source refinements (default fingerprint only) | 0.766 / 0.667 / 0.713 | 0.733 / 0.703 / 0.718 |
| minus references and title similarity | 0.943 / 0.817 / 0.876 | 0.912 / 0.856 / 0.883 |
| dedup and recovery pairing only | 0.776 / 0.611 / 0.683 | 0.760 / 0.660 / 0.706 |
| Keep-style (fitted) | 0.968 / 0.595 / 0.737 | 0.965 / 0.651 / 0.777 |
| Keep-style with the release tag in the fingerprint (refitted on dev) | 0.950 / 0.614 / 0.746 | 0.943 / 0.664 / 0.779 |
| every event alone | 1.000 / 0.588 / 0.740 | 1.000 / 0.644 / 0.783 |

Development:

| Variant (frozen parameters) | P / R / F1 labelled | P / R / F1 flipped |
|-|-|-|
| Proposed (full) | 0.990 / 0.886 / 0.936 | 0.927 / 0.921 / 0.924 |
| minus topology (tree, service/project/host folds, relays) | 0.994 / 0.721 / 0.835 | 0.949 / 0.770 / 0.851 |
| minus per-source refinements (default fingerprint only) | 0.840 / 0.744 / 0.789 | 0.787 / 0.789 / 0.788 |
| minus references and title similarity | 0.992 / 0.872 / 0.928 | 0.937 / 0.913 / 0.924 |
| dedup and recovery pairing only | 0.846 / 0.591 / 0.696 | 0.817 / 0.652 / 0.726 |
| Keep-style (fitted) | 0.912 / 0.607 / 0.729 | 0.904 / 0.676 / 0.774 |
| Keep-style with the release tag in the fingerprint (refitted on dev) | 0.984 / 0.584 / 0.733 | 0.978 / 0.654 / 0.784 |
| every event alone | 1.000 / 0.571 / 0.727 | 1.000 / 0.647 / 0.786 |

## 8. Error analysis (proposed system; mass = share of the weighted sample)

### Ten largest merge errors, held-out

| Mass | Size | Gold groups inside | Example ids | Class | Reason |
|-|-|-|-|-|-|
| 0.0206 | 9 | c05-g05:2, c05-g08:2, c05-g07:2, c05-g06:2 | 430, 432, 434, 436, 438, 440 | fp | fp: 434 (chat) with 432 (chat), gold c05-g04 vs c05-g05 |
| 0.0118 | 12 | c13-g18:6, c13-g17:2, c13-g21:2, c13-g22:2 | 1, 544, 688, 698, 997, 1198 | fp | fp: 1369 (hermes_log) with 1372 (hermes_log), gold c13-g17 vs c13-g21 |
| 0.0073 | 6 | c11-g07:3, c11-g11:3 | 1140, 1141, 1142, 1143, 1144, 1145 | fp | fp: 1140 (human) with 1141 (human), gold c11-g07 vs c11-g11 |
| 0.0066 | 2 | c05-g11:1, c05-g10:1 | 465, 467 | fp | fp: 467 (chat) with 465 (chat), gold c05-g10 vs c05-g11 |
| 0.0066 | 2 | c05-g02:1, c05-g01:1 | 404, 406 | fp | fp: 406 (chat) with 404 (chat), gold c05-g01 vs c05-g02 |
| 0.0024 | 3 | c11-g17:2, c11-g07:1 | 1148, 1169, 1199 | ref | ref: 1148 (human) with 1169 (human), gold c11-g07 vs c11-g17 |
| 0.0015 | 5 | c19-g13:4, c19-g12:1 | 13, 1453, 1454, 1692, 1693 | fold:host | fold:host: 1693 (kuma) with 13 (beszel), gold c19-g13 vs c19-g12 |
| 0.0011 | 2 | c17-g26:1, c17-g27:1 | 1611, 1612 | sim | sim: 1611 (github) with 1612 (github), gold c17-g26 vs c17-g27 |
| 0.0011 | 2 | c19-g07:1, c19-g09:1 | 1686, 1688 | fp | fp: 1686 (gh_alert) with 1688 (gh_alert), gold c19-g07 vs c19-g09 |
| 0.0011 | 2 | c19-g23:1, c19-g26:1 | 1703, 1706 | sim | sim: 1703 (human) with 1706 (human), gold c19-g23 vs c19-g26 |

### Ten largest split errors, held-out

| Mass | Gold group | Size | Predicted pieces | Example ids | Class | Reason |
|-|-|-|-|-|-|-|
| 0.0198 | c01-g11 | 9 | [6, 1, 1, 1] | 52, 53, 54, 55, 56, 57 | window | 61 vs 53: share project/host but 6270 min apart (w_topo 45) or under the distinct-subject threshold |
| 0.0190 | c07-g01 | 27 | [6, 6, 6, 5, 1, 1, 1, 1] | 102, 144, 145, 577, 578, 579 | unmapped subject | 102 vs 144: kuma subject has no host, project or service in the manifest |
| 0.0189 | c21-g01 | 19 | [2, 2, 2, 1, 1, 1, 1, 1] | 20, 501, 507, 516, 518, 1496 | window | 1517 vs 1690: share host but 781 min apart (w_topo 45) or under the distinct-subject threshold |
| 0.0182 | c11-g07 | 7 | [3, 1, 1, 1, 1] | 1125, 1140, 1143, 1144, 1146, 1147 | ticket text | 1140 vs 1125: tickets/briefs 1585 min apart, similarity 0.00 below th_sim 0.2 |
| 0.0110 | c11-g28 | 4 | [1, 1, 1, 1] | 1194, 1195, 1196, 1197 | ticket text | 1194 vs 1195: tickets/briefs 29 min apart, similarity 0.04 below th_sim 0.2 |
| 0.0066 | c05-g01 | 2 | [1, 1] | 406, 407 | chat text | 406 vs 407: chat message about a deploy or alert: no text-link rule |
| 0.0066 | c05-g05 | 4 | [2, 2] | 430, 431, 432, 433 | chat text | 430 vs 431: chat message about a deploy or alert: no text-link rule |
| 0.0066 | c05-g08 | 4 | [2, 2] | 436, 437, 438, 439 | chat text | 438 vs 437: chat message about a deploy or alert: no text-link rule |
| 0.0066 | c05-g11 | 2 | [1, 1] | 465, 466 | chat text | 465 vs 466: chat message about a deploy or alert: no text-link rule |
| 0.0037 | c09-g31 | 4 | [1, 1, 1, 1] | 979, 981, 982, 983 | unmapped subject | 979 vs 981: other subject has no host, project or service in the manifest |

### Ten largest merge errors, development

| Mass | Size | Gold groups inside | Example ids | Class | Reason |
|-|-|-|-|-|-|
| 0.0060 | 4 | c10-g13:3, c10-g20:1 | 1036, 1092, 1093, 1094 | fp | fp: 1092 (human) with 1093 (human), gold c10-g20 vs c10-g13 |
| 0.0027 | 26 | c20-g02:25, c20-g03:1 | 31, 253, 1691, 1716, 1717, 1718 | fold:proj | fold:proj: 253 (docker) with 1716 (kuma), gold c20-g03 vs c20-g02 |
| 0.0008 | 3 | c20-g02:2, c20-g01:1 | 265, 267, 1600 | relay | relay: 1600 (hyperdx) with 265 (relay), gold c20-g01 vs c20-g02 |

### Ten largest split errors, development

| Mass | Gold group | Size | Predicted pieces | Example ids | Class | Reason |
|-|-|-|-|-|-|-|
| 0.0166 | c20-g02 | 34 | [25, 2, 2, 2, 2, 1] | 31, 264, 265, 267, 310, 583 | unresolved relay | 1716 vs 264: monitoring relay whose monitor name is redacted or not in the manifest |
| 0.0145 | c04-g06 | 5 | [3, 2] | 353, 354, 355, 356, 357 | chat text | 356 vs 355: chat message about a deploy or alert: no text-link rule |
| 0.0126 | c04-g08 | 15 | [12, 3] | 376, 377, 378, 379, 380, 381 | chat gap | 376 vs 392: chat messages 335 min apart, w_chat 30 |
| 0.0097 | c06-g03 | 3 | [1, 1, 1] | 547, 572, 573 | unmapped subject | 547 vs 572: kuma subject has no host, project or service in the manifest |
| 0.0084 | c02-g03 | 9 | [6, 3] | 146, 147, 148, 149, 150, 151 | unmapped subject | 146 vs 147: kuma subject has no host, project or service in the manifest |
| 0.0073 | c04-g03 | 2 | [1, 1] | 330, 331 | chat text | 330 vs 331: chat message about a deploy or alert: no text-link rule |
| 0.0073 | c04-g07 | 4 | [2, 2] | 368, 369, 370, 371 | chat text | 368 vs 369: chat message about a deploy or alert: no text-link rule |
| 0.0069 | c08-g08 | 3 | [2, 1] | 11, 539, 798 | unmapped subject | 11 vs 539: kuma subject has no host, project or service in the manifest |
| 0.0068 | c18-g01 | 62 | [58, 2, 2] | 44, 45, 77, 103, 105, 110 | unresolved relay | 103 vs 105: monitoring relay whose monitor name is redacted or not in the manifest |
| 0.0060 | c08-g03 | 9 | [6, 1, 1, 1] | 707, 711, 715, 716, 717, 718 | unmapped subject | 707 vs 711: kuma subject has no host, project or service in the manifest |

## 9. Second labeller (post-freeze sensitivity on three held-out chunks)

Chunks 05, 13, 19 (129 events, 55 sampled). Labellers disagree on known_fix for [1372, 1373, 1380, 1381], on the genuine label for no event; grouping agreement (B-cubed F1 of A against B) 1.000.

| System | B-cubed F1 (A / B) | Escalation caught and escalated (A / B) | Known-error match, weighted (A / B), positives sampled (A / B) | Known-error false match (A / B) |
|-|-|-|-|-|
| Proposed | 0.859 / 0.859 | 0/0 of 0 / 0/0 of 0 | 0.000 / n/a, 1 / 0 | 0.016 / 0.016 |
| Today's warden | 0.770 / 0.770 | 0/0 of 15 / 0/0 of 15 | 0.000 / n/a, 1 / 0 | 0.000 / 0.000 |
| Keep-style | 0.771 / 0.771 | 0/0 of 0 / 0/0 of 0 | 0.000 / n/a, 1 / 0 | 0.000 / 0.000 |

## 10. Gold labels that look wrong or unreachable (listed, never relabelled)

- dev: known_fix=y whose referenced item has no recipe-bearing closure before the event: 1450 (item:1298), 1451 (item:1298)
- dev: one gold group, one fingerprint, known_fix both y and n: c10-g17 y=[1074, 1079] n=[1071, 1078]
- heldout: known_fix=y whose referenced item has no recipe-bearing closure before the event: 1372 (item:1368), 1373 (item:1368), 1380 (item:1372;item:1368), 1381 (item:1372;item:1368)
- heldout: one gold group, one fingerprint, known_fix both y and n: none

## Report section (MADR-ready, Spike 3)

Status: evidence for ADR-013 (intake and correlation) and ADR-014 (owner decisions), BRIEF Phase 4 item 3 and Phase 6 backtest. Rendered by `backtest.py`; the narrative is generated from the numbers and was fixed before the held-out pass.

### Context and problem statement

One outage must be one incident, and only the four business classes may reach the owner (BRIEF, section Fixed; ADR-014). Today's warden groups by ledger identity only (an item plus its `duplicate_of`/attach children), reads 63.7 % of its signals as Slack relays and sends about a third of new items to the owner (ADR-013, ADR-014). Question: replayed in `occurred_at` order without look-ahead over the labelled golden set (959 events, 458 true incident groups), does the proposed intake path beat today's warden and a Keep-style correlator on thresholds that were fixed before the first label existed?

### Decision drivers

- Grouping: weighted entity-centric B-cubed precision >= 0.90 and recall >= 0.80, F1 strictly above today's warden.
- Escalation: no genuine owner decision auto-closed, escalation precision >= 0.80, owner-touch share <= 1 %.
- Reuse: known-error match >= 0.50 to the right prior incident, false match <= 0.05.
- Cost: Keep is MIT with an open-core `ee/` split (v0.54.3, 668 open issues) and its rules are hand-written; its topology processor and gate specifics were not verified in the research run (`research/2026-10-22-ops-correlation-catalog-eval.md` section 1).

### Considered options

1. **Proposed (build):** per-source default fingerprints with refinements, dedup into open groups, topology fold over host / container-or-job / service / project inside a window, deploy suspects, candidate gate, known-error match (exact fingerprint, then token similarity), escalation only for the four business classes.
2. **Keep-style (adopt Keep's model):** partial dedup on (source, normalised title), one correlation rule (same service or host inside a window), an incident-candidate gate; no topology graph, no known errors.
3. **Today's warden (status quo):** ledger membership (`duplicate_of`/attach) and `needs_decision` transitions.

### Results (held-out split, odd chunks, scored once)

Cells read `labelled (flipped value)`; a threshold passes only if it passes under both readings. `PASS*` means vacuous: no positives or no escalations existed in that reading.

| Metric (pre-registered rule) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision (grouping): >= 0.90 | 0.937 (flipped 0.902) PASS | 0.993 (flipped 0.990) PASS | 0.968 (flipped 0.965) PASS |
| B-cubed recall (grouping): >= 0.80 | 0.846 (flipped 0.881) PASS | 0.595 (flipped 0.648) FAIL | 0.595 (flipped 0.651) FAIL |
| B-cubed F1 vs today's warden: strictly above today's warden | 0.889 (flipped 0.891) PASS | 0.744 (flipped 0.783) reference | 0.737 (flipped 0.777) FAIL |
| Escalation recall (genuine owner decisions escalated): 1.00, no genuine decision auto-closed (one miss only if its label is uncertain) | 0/1 caught (flipped 0/7) FAIL (labelled PASS, flipped FAIL) | 0/1 caught (flipped 6/7) FAIL (labelled PASS, flipped FAIL) | 0/1 caught (flipped 0/7) FAIL (labelled PASS, flipped FAIL) |
| Escalation precision (escalations that are genuine): >= 0.80 | 0.000 (flipped 0.000) of 4 escalated FAIL | 0.000 (flipped 0.105) of 57 escalated FAIL | 0.000 (flipped 0.000) of 4 escalated FAIL |
| Owner-touch share of items, sampling-weighted: <= 1 % (long-run 0.1 %) | 0.62 % PASS | 14.09 % FAIL | 0.62 % PASS |
| Known-error match on known_fix=y, matched to the right prior: >= 0.50 to the right prior incident | 0.479 (flipped 0.222), 1/5 sampled FAIL | 0.000 (flipped 0.000), 0/5 sampled FAIL | 0.000 (flipped 0.000), 0/5 sampled FAIL |
| Known-error false match on known_fix=n: <= 0.05 | 0.007 (flipped 0.007), 6/203 sampled PASS | 0.000 (flipped 0.000), 0/203 sampled PASS | 0.000 (flipped 0.000), 0/203 sampled PASS |

Sample: 484 events, 208 sampled elements (weight sum 893.2). Oracle owner-touch share, i.e. escalating exactly the labelled genuine decisions: 0.60 % labelled, 0.67 % flipped.

| Reference metric (labelled view) | Proposed | Today's warden | Keep-style |
|-|-|-|-|
| B-cubed precision, weighted (95 % CI) | 0.937 [0.893, 0.970] | 0.993 [0.980, 1.000] | 0.968 [0.935, 0.991] |
| B-cubed recall, weighted (95 % CI) | 0.846 [0.797, 0.890] | 0.595 [0.530, 0.659] | 0.595 [0.527, 0.660] |
| B-cubed F1, weighted (95 % CI) | 0.889 [0.854, 0.925] | 0.744 [0.692, 0.793] | 0.737 [0.686, 0.785] |
| F1 minus warden's F1 (95 % CI) | +0.145 [+0.098, +0.194] | - | -0.007 [-0.018, +0.003] |
| B-cubed P / R, unweighted | 0.936 / 0.793 | 0.971 / 0.653 | 0.963 / 0.648 |
| Pairwise P / R / F1 (all events) | 0.901 / 0.583 / 0.708 | 0.346 / 0.005 / 0.011 | 0.495 / 0.029 / 0.054 |
| Cluster P / R (exact groups) | 0.625 / 0.778 | 0.341 / 0.645 | 0.344 / 0.609 |
| Groups predicted / gold | 309 / 248 | 469 / 248 | 439 / 248 |
| Escalation precision / recall, all events (raw) | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |
| Escalations (sampled / all), genuine caught | 2 / 4, 0 of 1 | 57 / 57, 0 of 1 | 2 / 4, 0 of 1 |
| Known-error match in the top three candidates, weighted | 0.479 (1/5) | 0.000 (0/5) | 0.000 (0/5) |
| Known-error match, unweighted all events | 0.222 of 9 | 0.000 of 9 | 0.000 of 9 |
| Known-error false match, unweighted all events | 0.015 of 475 | 0.000 of 475 | 0.000 of 475 |
| Owner-touch share, weighted (95 % CI) | 0.62 % [0.00 %, 1.88 %] | 14.09 % [10.08 %, 19.37 %] | 0.62 % [0.00 %, 1.88 %] |
| Owner-touch events (sampled / all) | 2 / 4 | 76 / 94 | 2 / 4 |

### Error analysis

Mass is the share of the weighted sample that a group costs the proposed system (largest ten merge and ten split errors, held-out; ids in the tables above).
- Merge errors by class: fp 0.0540 (6); ref 0.0024 (1); sim 0.0022 (2); fold:host 0.0015 (1).
- Split errors by class: window 0.0387 (2); ticket text 0.0292 (2); chat text 0.0264 (4); unmapped subject 0.0227 (2).
  - window: events under one ancestor that fall outside the window or under the distinct-subject threshold.
  - ticket text: briefs or tickets about one topic whose titles do not overlap enough.
  - chat text: Slack narration of agents in the alerts channel that names a deploy or alert; ADR-013 retires that intake, so this is a frame artefact, not a correlator defect.

### What Keep's model lacks, and what it adds

- Measured: with (source, normalised title) as the fingerprint, Keep-style reaches held-out F1 0.737 (P 0.968, R 0.595), against 0.740 for leaving every event alone and 0.889 for the proposal. Adding the release tag to its fingerprint (refitted on dev) moves precision to 0.950, recall to 0.614 and F1 to 0.746.
- Measured: the proposal without topology folds scores F1 0.850, without per-source refinements 0.713, without references and title similarity 0.876, with dedup and recovery pairing alone 0.683. Keep-style has neither refinements nor topology, and an Up relay is a different title from its Down.
- By construction: Keep-style has no known errors (match rate 0) and no decision policy. A Keep incident candidate waits for manual approval, which is an owner gate that ADR-014 forbids, so this backtest hands Keep-style the same escalation module as the proposal; its escalation rows isolate correlation.
- Not run: Keep ships a topology processor (service map) and workflow engine; the brief defines the baseline without them and their specifics were not verified. What is worth copying is the promotion gate with predicates over alert attributes, which is already part of the proposal (design/loops.md section 2.5).

### Recommendation

- Grouping: build the proposed correlator. It clears all three grouping thresholds on held-out data under both readings (P 0.937, R 0.846, F1 0.889; today's warden F1 0.744, Keep-style 0.737). Do not adopt Keep as the correlation engine.
- Escalation: as labelled the policy escalates 4 held-out events and catches 0 of 1 genuine decisions (weighted precision 0.000); missed 1626 (uncertain: [True]); false escalations 968, 969, 970, 1571; flipped, the sample holds 7 positives and the policy catches 0.
  The policy fails as labelled: the evidence tables of `CLASS_EVIDENCE` need revision against the ids above before the policy gates anything; the thresholds are not moved.
- Owner-touch: 0.62 % of the weighted sample, inside the 1 % rule (oracle 0.60 %).
- Known errors: ke_match FAIL (match 0.479, 1/5 sampled; flipped 0.222; false match 0.007). Of the sampled positives 0 matched a different prior and 4 found no candidate.
  Recipes that live only in a commit, or in a closure with no merged change, are invisible to a store of closed incidents: attach Changes to incidents so a recipe exists when the incident closes.

### Confidence and limits

| Threshold | Point estimate (held-out, labelled) | 95 % interval | What the sample settles |
|-|-|-|-|
| B-cubed precision >= 0.90 | 0.937 | [0.893, 0.970] (entity bootstrap) | not settled by the sample |
| B-cubed recall >= 0.80 | 0.846 | [0.797, 0.890] (entity bootstrap) | not settled by the sample |
| F1 above warden | +0.145 | [+0.098, +0.194] (paired bootstrap) | pass settled |
| Escalation recall 1.00 | 0/1 | [0.000, 0.793] (Wilson) | fail settled |
| Escalation precision >= 0.80 | 0/4 | [0.000, 0.490] (Wilson) | fail settled |
| Owner-touch share <= 1 % | 0.62 % | [0.00 %, 1.88 %] (entity bootstrap) | not settled by the sample |
| Known-error match >= 0.50 | 1/5 | [0.036, 0.624] (Wilson on counts) | not settled by the sample |
| Known-error false match <= 0.05 | 6/203 | [0.014, 0.063] (Wilson on counts) | not settled by the sample |

Limits that bound every claim above:

- The labels are one labeller's reading of packets that include warden's own outcome. A second labelling of chunks 05, 13 and 19 is scored in section 9 of this file; it agrees on grouping and on the genuine label and differs on known_fix in chunk 13.
- Genuine owner decisions are rare: 6 of 959 labelled events (1 in the held-out split). Escalation recall and precision rest on a handful of events; the interval column shows which thresholds the sample can settle at all.
- The golden set holds only events within 30 minutes of a sampled event, so a recovery or a recurrence further away is invisible; the open-incident gap `w_open` is fitted to that frame.
- Topology is the live 2026-10-22 map applied to every date; monitors that no longer exist are unmapped and fall back to the default fingerprint.
- Visibility follows `occurred_at` (source time), as the primary-source adapters of ADR-013 deliver; a Slack-relay world adds a poll lag of up to 35 minutes.
- The investigation text that the escalation policy reads is the recorded text of today's agents; a changed investigator could ask different questions. The escalation evidence tables were written from the class definitions and revised once against development errors (development log).
- Severity `critical` of the candidate gate is not modelled (no severity field exists in the data); the gate is reported in the JSON but not covered by the pre-registered estimators.
