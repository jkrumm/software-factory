# Console v1: Needs you, with "Since you were here"

Shots of the screen at 1800x1200 (dark and light), 1280x800 (dark) and 390x844 (dark), taken by
`tests/e2e/since-band.e2e.ts` on a seeded history and copied here by `scripts/evidence-console-needs-you.sh`. The band
shots run with the browser clock three hours ahead of the seed, so the visit reads "3 hours ago"; the band's counts are
asserted against SQL on the event log in the same spec, with the real clock.

Compared against `apps/console/DESIGN.md` ("The screens: Needs you", the target, the rules) and the owner's three
reference images (`design-refs/console` in the factory's home directory: a hotel board with StatCards, a fleet dashboard
with a counted sidebar, the StatCard anatomy). Needs you has no chart; against the references it takes the counted
sidebar of 02 and the figure-over-label rhythm of 03 for the band, and keeps the chrome graphite.

## Rounds

| Round | Looked at | Findings | Changed |
|-|-|-|-|
| 1 (lead) | 1800 dark band, decision, held signal; phone band | P1: seventh band category orphaned on a second row, its label wrapped with the hint stranded; the phone band pushed every checkpoint below the fold; an empty "Issue" property in a held signal; the default line read "(in 7 hours)" after a full stop. P2: no time on band items, wordy intro, a summary that repeated the title | Figure over label, hint inline, 11 rem columns; on a phone a 2-column grid with the items in one Fold; a missing property reads "None"; "In 7 hours, if nobody answers: ..."; item times; the summary line is dropped when it repeats a title |
| 2 (lead) | all three viewports, new shots | P2: the time column squeezed titles to 2-3 lines; "Turned away by the screen" wrapped | The time moved into the meta line under the title; the label is "Turned away" with the screen hint |
| 3 (reviewer subagent from `basalt-design-reviewer.md`, 38 findings) | all 15 shots against the three references | Accepted: "10 waiting" collided with the strip's "2 waiting" (now "10 need you"); a filtered list did not say what it filtered ("Showing X of Y, Clear filters" at every width); two time phrasings for one age; the odd last band category on a phone; a repeated question heading; an unstyled Issue link; the band could not show an away period (all items "just now") | All fixed; the shot spec moves the browser clock three hours ahead so the band reads as a morning away |
| 3, not taken | | The same Issue in two categories (a fix filed and shipped in one visit is counted in both: the counts follow the event log); a Decision framed as the lead's question (the owner asked for exactly that framing, plus its free-text answer last); the recommended card's accent ring (the mark of the recommendation); status tiles behind the figures; the tab order of the header meters (the frame's, not this screen's) | |

| 4 (reviewer, last) | all 15 shots after round 3 | No P0, no P1: "clean". P2: the option cards stay about 350 px wide at 1800; the 1280 band wraps 5 + 2; Swap is absent from the phone strip (the frame's); the phone filters are native selects (the below-`md` pattern Flow uses); the recommended card's ring and the blue selection dot are taste. P3: the errand body repeats a seeded title, a hyphen where an em dash belongs in the Errand definition, "me 20%" in the strip (the frame's) | Left for the owner's review (`console-owner-review`), none blocks |

The reviewer ran without `basalt-ui shot` metrics (the Console's Playwright shots stand in for them, as DESIGN.md says),
so its craft scores were by eye.

## Files

`<viewport>-<shot>.png`: `band` (the screen on its first view), `band-open` (phone, the Fold open), `decision-open` (option
cards), `errand-open`, `held-open` (source, link and when), `filtered` (`?project=argo`).
