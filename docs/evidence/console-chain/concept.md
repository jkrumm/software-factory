# Chain: concept

Written before the code (basalt-design step 1, adapted to the Console's Base UI and Tailwind).

## The question the screen answers

What waits for what, what is stuck on something that has not closed, and, for work that waits on a clock, when it runs.

## Decisions it supports

- Is a blocker still open, and can I unblock it? (blocked edges stand out, the blocker's card opens its Issue)
- Is the burn-in report that was scheduled for next week still on its date? (the schedule band)

## Layout at 1800x1200

- Header: "Chain" and one line (blocked, done, not drawn).
- The graph takes the rest of the viewport, edge to edge of the content area, on the canvas surface step. No bordered box.
- Nodes are the kit's IssueCard at a fixed 288 x 120 (dagre needs a fixed size): clamped title, KindBadge, project chip,
  state Lozenge, the wait reason or, for a plan row, "Not before <date>" with a clock icon, the age in mono. An Issue is a
  link to its page. A plan row is the same card on a dashed outline, "Not filed yet" in the chip row, no link.
- Blocked edge: solid, warn tone, 2.5 px, labelled "blocks". Satisfied edge: dashed, faint, labelled "done". Colour is
  never the only cue.
- Schedule band under the graph: a time axis from now to the last scheduled date inside 120 days (at least 7 days), day or
  week ticks in mono, a "Now" mark at the left. Each plan row with `not_before` is a marker on its date with a chip (title,
  project, date). Chips that would overlap stack in lanes. Rows dated beyond the horizon sit in a "Later" cell at the right
  end with their date. The band lists every scheduled row of the project filter, with or without an edge.
- Legend: three entries (blocks, done, not filed yet) in the graph's corner.

## At 390

The graph keeps a 24 rem height and pans; the schedule scrolls inside itself; the page never scrolls sideways.

## Copy

No ids. Dates are `Mon 16 Nov, 09:00` in the viewer's zone with the UTC instant on hover; the relative distance ("in 6 days")
beside it.

## Pass criteria

- Graph region is at least 90 % of the content area's width and at least 50 % of the viewport's height at 1800x1200.
- Every API edge and node is drawn; a scheduled row sits on its date in date order; a row beyond the horizon is in "Later".
- Dark and light read the same; no raw colour (the `no-raw-colour` test).
