# Console Improve: a StatCard per KPI

Screenshots from `tests/e2e/screenshots.e2e.ts`, named `<viewport>-<theme>-improve[-30][-tall].png`. `desktop-xl` is
1800×1200, `desktop` 1280×800, `phone` 390×844; `-30` is the 30-day window; `-tall` is the same screen in a taller window
(the shell scrolls inside itself, so the plain shot stops under the cards and Friction, the Fold and the held classes are
only in the tall one). The seed is the e2e server's (`seed.ts`) plus `seed-kpis.ts`: fourteen closed Issues on days 9 to
140 before now (queue waits, cycles, owner notes, refused events) so the KPIs have readings in the windows before; the 7-day
line has no day 21 to 28 back, so it breaks there. Cost and window points are not measured (no usage schema in the lab).

## What I compared, and against what

The owner's reference `design-refs/console/03-statcard-anatomy.png` (also 01 and 02) was read from the factory's home
directory and set against each round's shots and `apps/console/DESIGN.md`. The rounds were my own reading of the shots, not
a reviewer subagent, and `basalt-ui shot` was not run (the Console has no `data-shot` anchors).

Against reference 03 the cards keep its anatomy: an icon tile, title and a subtitle that names the comparison, a large
tabular figure with a delta pill, one sub line, a chart with three x labels, and a footer of two pairs on the shell step,
with the body one surface step below, no border, no coloured left bar. A KPI's chart is a line with its target dashed
(a range is two dashed lines and a faint band) and gaps where nothing was counted; the line is green or red by the
verdict on the current figure and grey with no verdict. The fix-commit card is stacked bars by week, oldest left.

| Round | What fell short | What changed |
|-|-|-|
| 1 | Not-measured cards read "Not measured" twice (figure and sub line). The fourth title ("Decisions the owner marks worth asking") truncated at 1800. The stacked bars were 24 px in a 700 px card and read as unfinished. | Sub line left out for an unmeasured KPI (the footer says why). Title wrapped to two lines. Bars capped at 40 px. |
| 2 | The wrapped title pushed that card's figure 17 px below its row mates, so the row no longer aligned. The seed's refused events showed up in Friction with a made-up detail. | Title back to one line with the full text as a tooltip (the figure row is the alignment that matters). Refusal detail made realistic. |
| 3 | 1800 dark and light, 1280 and 390, 7 and 30 days read again: no clipped or overflowing text, four columns at 1800, two at 1280, one on the phone, the fix card spans two where it can, no height jump between the 7 and 30-day shots, figures tabular, tone only through the tokens. | Nothing further. |

Known gaps: where the usage KPIs are unmeasured and share a row with the taller fix card at 1800, the two cards have an
empty body (the card must not draw a chart it has no data for). A KPI with one reading shows a dot and no line. A bar
cap of 40 px is wider than the dataviz skill's 24 px, on purpose for a card with four bars. Light-mode series slots 2 to 5 sit
under 3:1 on the page surface (the skill's relief rule): the legend carries each class with its total, the tooltip lists the
classes and the table sits under a Fold.

## Figures match the API

`tests/e2e/improve.e2e.ts` reads `/v1/kpis?days=7|30` and `/v1/fix-commits` and asserts, for each of the ten KPI cards (found
by their heading, in the Console's own order, the headline measures first) that the figure is `formatKpi` of the API's value, that the change pill
and its tone, the sub line and both footer values are what `src/lib/improve.ts` makes of the API's history and target, that
the hidden table behind each chart holds the six windows, that a Not-measured KPI has no chart and says why, that the
tooltip of a chart names the window and its count, and that the fix card's total, change, legend, busiest class and table
of weeks by class are the API's. The page computes only differences; every number comes from the API's figures.
