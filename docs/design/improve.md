# Improve: concept

The Console's Improve route, rebalanced (Issue 665). The owner's review of Console v1: "I like our new card component
here but the UI seems slopped out, unbalanced, not well structured or positioned." Built against
`apps/console/DESIGN.md`.

## The question the screen answers

Is the factory getting better, and where is it not? One glance gives the verdict against the targets; a scroll gives
the history of each measure; the bottom gives the causes (fix classes, friction).

## v1 faults, measured at 1800 and 1280

- One `auto-fill` grid of 11 cards plus a double-width Fix card: rows of 4, 4, 2+wide, with an empty corner at 1800 and
  a lone pair at 1280. No grouping, no order a reader can follow.
- Cards in a row differ in height and inner position: a two-line title pushes one figure down, a card without a sub line
  starts its chart higher, the two "Not measured" cards are short beside tall neighbours.
- Below the cards a two-column block of unequal columns: Friction (a long single column of nine boxes) beside a short
  stack of two small items; the rest of the right column is empty.

## Structure

One page, seven bands, each a `Section` (heading, hairline, space; never a box). Every card band sits on one 4-column lattice (4 from a container of `@7xl`, 2 below it, 1 at 390), so a
row is full and equal.

| Band | Content | Grid at 1800 | At 1280 | At 390 |
|-|-|-|-|-|
| Against target | a summary strip: one tile per KPI with a target (first verification passes, avoidable touches, asks, decisions worth asking, refusals), each with a status lamp and word (Met, Missed, No data, Not measured), its figure, its label and its target; a tile links to the KPI's card. One DOM, two layouts: tiles from a container of `@7xl`, compact rows in one panel below it (one line from `@md`, two lines on a phone so the label is never cut). The heading's aside tallies the targets met ("3 of 5 targets met") | one row of tiles | compact rows | compact rows |
| Quality | first verification passes, avoidable touches, asks, decisions worth asking | 4 | 2 | 1 |
| Pace and gates | queue wait 90th percentile, queue wait median, cycle median, refusals | 4 | 2 | 1 |
| Spend | window points and cost, two columns each at 1800, one each at 1280; no charts, so short | 2 + 2 | 2 | 1 |
| Fix commits | the Fix commits StatCard (stacked bars by week and class) beside the fix-class table, always open | 2 | 2 | 1 |
| Friction | the friction groups as balanced columns inside one panel (groups of a single row without a hint share one "Also counted" group); then held finding classes | 3 columns of groups | 2 | 1 |

The strip repeats a figure to state its verdict at a glance; the cards carry the history behind it.

## Card law (applies to every StatCard on the route)

- Equal height per row (grid stretch) and aligned inner positions: header, figure and sub line start at the same y in a
  row; the chart and its x labels sit at the bottom of the body; the footer is level. A card with a long title wraps to
  two lines, the others are not pushed: the header row is shared through a subgrid.
- A card with nothing to plot ("Not measured") keeps the row height and states its reason in the body, top-aligned.
- Pairs: figure, delta pill, one sub line, chart with three x labels, two footer pairs (the kit's anatomy, unchanged).

## Fix commits band

The StatCard (left) keeps its figure, delta and stacked bars. The table (right) is the fix classes by week, oldest left,
with a total row; it is a panel, not a Fold, because at 1800 there is room and the table is the card's numbers.

## Friction band

One `bg-card` panel, `columns-1 @3xl:columns-2 @6xl:columns-3`, each group `break-inside-avoid`: the browser balances
the columns, so no column is a stub. A line under the heading says how many Issues were filed and closed. Held finding
classes follow as a one-line section (a list when some are held).

## Copy

Section headings: Against target, Quality, Pace and gates, Spend, Fix commits, Friction, Held finding classes. No new domain word.

## Pass criteria

- No ragged row, no orphan card at 1800×1200 and 1280×800 (every band's last row is full), in dark and light and at 390.
- Equal heights per row; figures aligned across a row.
- `make check` green; every existing Improve e2e assertion still holds (they read the cards by title, not position).

## Rounds

Each round: Playwright shots at 1800×1200, 1280×800 and 390×844, dark and light, plus `basalt-ui shot` and `shot detect`
on the built Console, read by an isolated reviewer subagent beside the owner's references (`design-refs/console` 01 to
03) and the previous round. The shots were of v1 (`/tmp/improve-v1`) and rounds 1 to 5.

| Round | What was compared | Findings | Changed |
|-|-|-|-|
| 1 | v1 beside round 1 (bands, subgrid rows) | P1 two Not-measured cards with a void over 40 % in a 3-column band, footers wrapping at 1280; P1 week dates wrapping in the class table; P2 void under the class table | One 4-column lattice for every card band; Refusals into Pace, window points and cost into a Spend band of their own; short dates, rows that share the panel's height; `data-shot` anchors |
| 2 | round 1 beside round 2, the references | P1 the top band was not a summary and its tally said 5 of 4 cards; P1 class table clipped at 390; P1 subtitles truncated at 1440 and titles misaligned; P2 friction headings repeating their row, no column labels | Summary strip as its own first band; the 4-column lattice from 80rem; header top-aligned; phone table fits; friction meta in the heading line |
| 3 | round 2 beside round 3, Flow and /kit for the header change | P1 the strip carried no figure; P1 the strip ran 530 px on a phone and cramped at 1280; P2 single-row friction groups off the rhythm | Figure and target in every tile; compact rows below 80rem; one legend sentence instead of per-group labels |
| 4 | round 3 beside round 4 | P1 phone strip labels truncated; P2 the arrow read as a trend; P2 loose single-row groups | Two-line phone rows, a caret, a fixed status column, one "Also counted" group |
| 5 | round 4 beside round 5 | No card-row finding. P2 Friction column tails uneven at 1280 and 1440 (group granularity of the CSS columns); P3 polish | Left: a group cannot split across columns without losing its heading |

Left on purpose: the detector's font-size findings and the light-scheme delta-pill contrast (4.15 to 4.22 against 4.5)
belong to the StatCard anatomy and the tone tokens, which are kit-wide and the owner's taste; friction labels wrap because
the API words them; Spend is two honest Not-measured cards; the header meter strip clipping "Swap" at 390 is the frame's.
