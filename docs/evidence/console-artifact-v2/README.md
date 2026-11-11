# Console v2: the artifact page

Screenshots from `tests/e2e/screenshots.e2e.ts` (`make e2e`), named `<viewport>-<theme>-<screen>.png`. `desktop-xl` is
1800×1200, `desktop` 1280×800, `phone` 390×844, each dark and light. Screens: `artifact-report` (a Report in the shared HTML
template with four comments; the third is open, its card on the next surface step with edit and delete, its passage painted
stronger in the frame), `artifact-spec` (a Markdown Spec with a passage selected and the comment popover open under it, a
half-typed comment in it), `artifact-spec-verdict` (the same page with the verdict popover open from the header),
`artifact-compare` (a Report against its first revision).

## What changed against v1 (`../console-artifact-v1`)

| Ask | Built |
|-|-|
| Document centred, prose near 75ch | The document is centred in the column left of the 24 rem panel; Markdown and the template cap at 75ch; tables fill that measure (v1's table shrank to its content). Asserted in `artifact.e2e.ts` (centre within 2 px of the column's) |
| Full page is a designed view | A header band under a hairline: a link back to the Issue (number, title, Lozenge, project chip), the title, kind, format, author and age, the revision selector and the verdict as a button with a popover (a Lozenge with its note once given) |
| Comment cards | Author tile and name, mono time, "edited", the passage as a tinted chip, the words, the heading path in mono; the revision only when it is not the one shown; group headings only when there is more than one group; the general comment box at the panel's foot |
| Click a comment | The card opens (next surface step, faint shadow), the passage scrolls into view and paints stronger with an underline (`annotation-active`; in an HTML frame `factory-active` through `factory.scroll`); edit and delete are in the open card; a new selection lets go of it. Asserted for Markdown and the frame |
| Composer beside the selection | A popover anchored under the passage on its left edge (`popoverPosition`: above when no room, inside the viewport, following the passage through scroll); a bottom sheet below 1024 px. Asserted: within 24 px under the passage, left edges within 2 px, for Markdown and the frame |

## What I compared, and against what

Compared with the owner's reference images (`design-refs/console` 01 to 03: graphite surface steps, no borders for depth, small
dense type, one accent), `apps/console/DESIGN.md` ("Rules", "The target", "The screens: Artifact") and the previous round, by an
isolated reviewer subagent per round (a general-purpose Sonnet agent given the round's boards, the references, the previous
round and DESIGN.md, told no target score) and by me looking at each shot. `basalt-ui` is not installed in this checkout, so
`basalt-ui shot` and `shot detect` were not run and the Console has no `data-shot` anchors; the review was on the Playwright
boards, which also cover 1800×1200.

## Review rounds

| Round | Findings | What changed |
|-|-|-|
| 1 | No P0. P1: header and document left edges looked unrelated; the spec table was narrower than the prose; the popover covers the text under the passage; phone popover docked rather than anchored. P2: light-theme cards and quote chips nearly invisible; the active card had a heavy ring; "ON THE TEXT 3" repeated the count; the revision pill competed with the verdict button; the revision suffix repeated on every card | Header got a hairline so it reads as a toolbar over the centred document; tables fill the measure (a wrapper scrolls); chips and the author tile take the neutral tint; group headings only with more than one group; the revision only when it differs; the pill is a plain chip. The popover stays under the passage (a gutter of 236 px at 1800 cannot hold 352 px) and the phone keeps its bottom sheet: both are recorded in DESIGN.md |
| 2 | No P0. P1 (same two, recorded as decisions) and: the active passage in an HTML frame looked like the others (the screenshot was taken before the frame's message arrived, and the frame had no colour of its own for it); the active card still had a ring. P2: compare repeated the counts; cards not in document order; the light TLDR callout is faint | The shot waits for the frame's highlight; the frame's active rule has its own fallback colour; the active card is a surface step with a faint shadow, no ring; counts left out of group headings |
| 3 | No P0, no P1. P2: the pending selection under the open popover looked like a commented passage; light code block and TLDR near the canvas; touch shows edit and delete on every card (by design); the phone boards do not show the active passage. P3: compare's header wraps at 1280; card order is the order they were made in, not the document's | The pending passage is painted stronger than a commented one, in the page and the frame. Not changed: the light template tints, card order |

Open, not chased: the popover's position follows the page's scroll for Markdown only (an HTML frame reports the rect once, at
selection); cards are in creation order, not document order; the revision selector wraps to a second row in compare at 1280.
The boards in this folder are from the final `make e2e` run (181 passed), which includes round 3's one change (the
pending passage's paint); no reviewer saw that last shot.
