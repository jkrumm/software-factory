# Console Chain: full screen and the schedule

Screenshots from `tests/e2e/screenshots.e2e.ts`, named `<viewport>-<theme>-chain[-tall].png`. `desktop-xl` is 1800×1200,
`desktop` 1280×800, `phone` 390×844; `-tall` is the same screen in a taller window (the shell scrolls inside itself, so a
plain 1280×800 shot cuts the Schedule at the window edge). The seed is `tests/e2e/seed-chain.ts`: a chain across two
projects with a satisfied edge, and `quartz`'s plan with a row far away (2099), two burn-in rows two and nine days out
(the second after the first) and one 40 days out. `concept.md` is the concept written before the code.

## What I compared, and against what

The owner's reference images (`design-refs/console`) were read from the factory's home directory. Each round a fresh
reviewer subagent, briefed with `basalt-design-reviewer.md`, saw the round's shots beside the references and
`apps/console/DESIGN.md`, with no target score. `basalt-ui shot` boards and `metrics.json` were not run (the Console has no
`data-shot` anchors), so the Craft items that need metrics are by eye.

| Round | Findings | What changed |
|-|-|-|
| 1 | P1: the 1280 and phone shots in that round were stale (an older build), so only 1800 was judged. P1: phone graph unreadable. P1: a `done` and a `blocks` edge ran into one handle with their labels on one line. P1: an Issue card carried no wait reason. P2: plan cards had two anatomies; the Schedule read as floating cards, not a time axis; sub-13 px muted text; light canvas the same as the page | Two target handles (blocked, done); every card one reason line; plan card one anatomy at 320×128; gridlines, a stem to every chip, a break mark and "beyond 120 days" for the Later cell; text raised; a canvas surface step |
| 2 | P1: phone graph still at 0.55 zoom. P2: Settling and Closed cards had no reason line; controls covered a phone card. P3: dark cards read recessed; a chip covered a neighbour's dot | Phone zoom floor 0.9 anchored top-left and a 30 rem canvas, controls top-right; reason lines from `docs/language.md` for every state; dark cards one step above the canvas; chips stack so each dot reaches its own chip |
| 3 | Round 2's items re-shot and read by me; the desktop shots have no P0 or P1, the phone is legible | Nothing further |

The code review (`agw review`, standard then deep) found: `notBeforeMs` repeated in the read layer and a different
`Date.parse` at the row-state site (one rule now, repeated once because `read/` may import only types from a domain);
the raw `dependency` wait reason shown on a card (now "Waits for <blocker>"); and a test that broke once the year
changed (the date words take the clock as a parameter). The repeated kind and since SQL of the Flow read stays a nit.

## Known gaps

- At 1800×1200 the graph leaves empty canvas right of its last column (the fit stops at 1.1× so a small graph is not
  blown up).
- Wait reasons other than `dependency` show the stored word, as Flow does today.
- No hover or focus shot is in the set; the Playwright suite asserts every Issue card is a link and reachable.
