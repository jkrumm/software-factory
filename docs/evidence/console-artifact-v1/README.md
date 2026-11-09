# Console v1: the artifact page

Screenshots from `tests/e2e/screenshots.e2e.ts` (`make e2e`), named `<viewport>-<theme>-<screen>.png`. `desktop-xl` is
1800×1200, `desktop` 1280×800, `phone` 390×844. Screens: `artifact-report` (a Report in the shared HTML template with four
comments, one edited, the pointer on the edited one so its Edit and Delete actions show), `artifact-spec` (a Markdown Spec
with a passage selected and the comment box open beside it, a half-typed comment in it) and `artifact-compare` (a Report
against its first revision, the 1800×1200 pair only).

## What I compared, and against what

The owner's reference images (`design-refs/console` in the factory's home directory) are **not on this machine**, so no
screen was compared against them. Each was judged against `apps/console/DESIGN.md` ("What v0 got wrong", "Rules", "The
screens: Artifact", "Done means"), by the lead looking at each shot, two rounds of shooting. No reviewer subagent ran on the
boards and `basalt-ui shot` was not run (the Console has no `data-shot` anchors yet).

**Against "The screens: Artifact".**
- The document fills the page: no `max-w-6xl` shell, no card around it, no padding box. Markdown prose is left-aligned at up
  to 80ch; an HTML artifact's frame fills the height and the width up to the panel, with no border or radius.
- Comments are a 25 rem panel on a surface step (no border) at the right, full height, scrolling on its own from `lg`; below
  `lg` it stacks under the document. The verdict is its first section, flat.
- Selecting a passage opens the comment box in the panel column level with the passage and clamped on screen; the passage
  stays painted while the box has the focus. Below `lg` the box docks at the bottom.
- A comment can be edited (the owner's own) and deleted (any, two steps); the actions are siblings of the card, icon buttons
  shown on hover, focus and touch.
- Templates: no left bar anywhere (`test/no-accent-bar.test.ts`), callouts a tint with no border, code and figures a tint, table
  rows hairlines; the TLDR blockquote is a calm tinted block.
- 390 does not scroll sideways (asserted in `tests/e2e/artifact.e2e.ts` for the Spec, the Report and a comparison).

## Review rounds

| Round | Findings | What changed |
|-|-|-|
| 1 | No P0. P1: the panel's surface step started under the header, so the right column floated at the top with a gap above it. P2: an HTML artifact's text began 16 px in while the header and Markdown began 32 px in, so the left edges did not line up; the page header's revision links wrapped to a second right-aligned row at 1280. P3: the comment box covers the general-comment field it opens over | The grid now spans the whole height with the header inside the document column, so the panel is full height; the template's body padding is 32 px at the sides; the box overlap stays (it is level with the passage, as asked) |
| 2 | No P0, no P1. P2: the Edit and Delete actions are not visible at rest, so the shots never showed them. P3: in light the TLDR tint is faint on the canvas; prose leaves space between its 80ch and the panel at 1800 (running prose caps, the panel uses the rest, per the target) | The Report shot hovers the edited comment so the actions show; the rest is not changed |
| 3 | No P0. P1: at 1800 the reading column hugged the left with about 400 px empty before the panel; in the Spec shot the open box cut "Add general comment" in half; at 1280 the revision links wrapped to a second right-aligned line (a first try that only truncated the title left the title blank and clipped the compare select). P3: with no comments the box overlaid only a hint line | The reading column is centred in the document area and the Markdown measure and the template's width are 88ch (the frame still fills the height); the general-comment form moved to the top of the list and the box has a stronger shadow with a hairline ring; the header does not wrap from `lg` (the title truncates, and format, author and age show from `2xl` only); the Spec shot's seed has three comments so the box floats over list items |

Open, not chased: the box's position follows the document's scroll for Markdown only (an HTML artifact's frame reports the
rect once, at selection); the 1280 header hides format, author and age to stay on one line; no reviewer subagent or
reference images were available.
