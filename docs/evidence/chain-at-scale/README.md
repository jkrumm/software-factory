# Chain at scale: 400 nodes in one project stay readable

Issue 663. The owner's review of Console v1: "basalt-ui has 369 tickets queued, obviously overwhelmed in the view." The
chain held 407 nodes, 370 of them basalt-ui's (62 Issues, 308 plan rows not yet filed), all drawn at once.

Screenshots come from `tests/e2e/chain-scale.e2e.ts`: the Chain against a seeded chain of 400 nodes in one project
(`tests/e2e/seed-scale-chain.ts`: 5 open Issues, 40 closed, 3 rows that may file now, 352 plan rows in 8 steps, a dated row
per step), answered for `GET /v1/chain`. Named `<viewport>-<theme>-chain-scale-<state>.png`: `collapsed` is the default view,
`opened` the first group opened, `group-card` and `group-card-rows` one card up close (closed Issues, plan rows). `desktop-xl`
is 1800×1200, `desktop` 1280×800, `phone` 390×844. The other Chain screens (the lab's six-node chain) are unchanged: a chain of
60 nodes or fewer is still drawn whole.

## What changed

- **Default view** (`lib/chain-collapse.ts`, for a chain of more than 60 nodes under the project filter): every open Issue,
  the plan rows that may file now (20 per project), the 6 newest closed Issues beside them; the rest of a project folded into
  **group nodes** of the card's size: plan rows by their after-depth (how many rows must file and close first; four and more
  share the last group) and the closed Issues past the budget. A group shows its count, "Not filed yet" or "Closed", the
  earliest date among its rows, its reason and an Open cue; a click opens it in place, the view moves to its rows, "Fold all"
  closes every group. The page note says how many nodes are folded. The plan has no grouping of its own, so the depth is the grouping.
- **Fit** (`graph.tsx`): a graph that cannot fit above 0.5 zoom (a desktop) or 0.9 (a phone) opens at that zoom on its first
  nodes instead of shrinking to unreadable cards; the fit control is ours (xyflow's own fit ran beside it and ignored the floor).
  The canvas is taller (70 vh) while groups exist.
- The project filter, the schedule (read from the whole chain, not from what is drawn) and the node cards are unchanged.

## Numbers (Playwright, Chromium, this host)

| | |
|-|-|
| Default view of the 400 | 14 cards plus 5 groups (386 nodes folded); the acceptance bound is about 40 plus groups |
| Opening a group of 44 rows | 22 to 26 ms, click to the painted rows (bound 100 ms) |
| Worst frame while panning and zooming | 23 to 25 ms (bound 100 ms) |
| Layout of the default view | about 7 ms (`apps/console/test/chain-collapse.test.ts`) |
| Needs you to Chain, first paint | median 24 ms over 7 runs, no script fetched by the click (unchanged) |

## What I compared, and against what

The owner's reference images (`design-refs/console`) are **not on this machine** (the same as for Issues 657 and 661), so no
screen was set beside them; the in-product reference is the Chain's own IssueCard, a group is built from the same shell, header,
inset body and footer. `basalt-ui shot` boards were not run (the Console has no `data-shot` anchors). Round 1 and 2 I read
myself, beside the previous round; round 3 went to a subagent briefed with `basalt-design-reviewer.md` and
`apps/console/DESIGN.md`, which saw the round's shots and was given no target score. Round 4 is the fixes plus my own read.

| Round | Findings | What changed |
|-|-|-|
| 1 | P1: the 400-node default fits at about 0.25 zoom, so no card is legible (a 12-card stack of closed Issues plus a seven-rank chain of groups). P2: the canvas is 450 px tall for a graph this size | closed Issues beside open work cut from 12 to 6; a desktop floor zoom of 0.5 with the graph opened on its first column; a taller canvas while groups exist |
| 2 | P1: a framed box behind every group card (xyflow styles a node of type `group` as its own frame); P1: a phone opens on empty canvas (top left of a graph whose first column is mid-height); P2: the earliest date was in the markup only; P2: nothing says a group is a button | the node type is `folded`; the floor anchors on the first column (phone) and the top (desktop); the date is a visible line; an Open cue in the footer |
| 3 (subagent) | P1: the Fit control ran xyflow's fit beside ours, so Fit then open ended at 0.1 zoom; P1: an opened group of 44 lands off screen; P2: the Open cue is faint; the count is repeated in header and title; P2: the dashed group had no close-up; P3: Fold all barely filled in light; the open row shifts the canvas 40 px. Also noted: the legend covers part of the graph at 1280 and 1800 (the legend is unchanged by this Issue) | our own Fit control; the opened group's rows are brought into view; Open is a filled pill; the duplicate count is gone; the step cap is 4 (a shorter chain of groups); Fold all on the accent step and its row's height reserved |
| 4 | I read the opened, collapsed and card shots in dark and light at 1800×1200 and the 1280 and phone ones: cards legible at the floor, groups distinct, the opened group in view, no box behind a card | nothing further |

Left as found: the legend sits over the graph's bottom right corner (its place since v1); at 1800 the default view shows the
first groups clipped at the right edge, the rest is a pan away (the page note counts them); the schedule is unchanged.
