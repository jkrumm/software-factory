# Console kit: `/kit` at 1800×1200, dark and light

Screenshots of `/kit` from `tests/e2e/screenshots.e2e.ts` (`make e2e`; they land in `tests/e2e/out/screenshots`).
`-kit.png` is the whole route on a tall viewport of the same width (the Shell scrolls inside itself, so a full-page shot
stops at the viewport height); `-kit-first-screen.png` is the 1800×1200 viewport itself.

| File | Viewport |
|-|-|
| `desktop-xl-dark-kit.png`, `desktop-xl-light-kit.png` | 1800×1200 width, the primary target |
| `desktop-dark-kit.png`, `desktop-light-kit.png` | 1280×800 width, must not break |
| `phone-dark-kit.png`, `phone-light-kit.png` | 390×844 width |

## What I compared, and against what

The owner's references are outside the repo (`design-refs/console` in the factory's home directory); the brief is
`apps/console/DESIGN.md`.

**StatCard against `03-statcard-anatomy.png`.** Matches: the header (icon tile, title, subtitle naming the comparison, ⋯
button); the body one surface step off the shell and with no border; the large figure with the delta pill (arrow, sign,
tone from direction times `higherIsBetter`); the sub line; the sparkline with its dashed future and dashed target rule;
three x labels with the last one dashed-underlined when the series runs into the future; the footer as two inline
key-value pairs. First pass differed in two places and I changed them: the footer stacked label over value (the
reference reads inline), and a fourth card wrapped to a second row at 1800 (the grid is now `auto-fill` from 22 rem, so
four sit in a row at 1800 and one at 390).

**Against `01-hotel-board-statcards-dark.png`.** Four cards across the full width, depth by surface steps and one faint
shadow, no borders. Not matched on purpose: the reference colours bars purple and yellow; the Console's rule is that
colour carries state only through the tone map, so the highlighted bar is the accent and the rest are muted. The body
step in dark is subtle (Basalt's dark surfaces have `bg` one step under `panel`, nothing deeper); the reference's is
stronger. I kept Basalt's values rather than add a surface to the tokens.

**Against `02-fleet-sidebar-statcards-topology.png` (light).** Light cards read the same way: panel on canvas with a
hairline ring, a quiet body, state as a tint on its tone (the Lozenge). Not adopted: the mono capitals on the card labels
and the sparkline bars in the card corner; the brief's anatomy puts the figure first.

**Against `DESIGN.md`.** No coloured left bar or box inside a padded box anywhere on the route (the quotes on the
existing screens were changed to a surface step in the same change). Rows have hairlines only between them, with the
project, state and reason in fixed columns so a list reads down. Every card and row is a link with a pointer, hover and
focus-visible ring; an IssueCard's ⋯ appears on hover. Every number is tabular except the large figure (the dataviz rule for
standalone figures). Every chart has a hover tooltip and the figure beside it. Domain words carry an InfoHint whose text
is generated from `docs/language.md`.

**Known gaps.** The IssueCard titles clamp early in a half-width grid because the age column takes its fixed width; fine
for the kit, to be tuned on the Flow board. "Held signal" has no row in `docs/language.md`, so it has no InfoHint until
the language table gets one.
