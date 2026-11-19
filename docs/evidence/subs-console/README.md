# Accounts screen: evidence

Playwright (`tests/e2e/accounts.e2e.ts`) on seeded data: 1, 3 and 8 accounts at 1800x1200, dark and light; 3 accounts at 1280x800 and 390x844. The
seeded set holds every shape the page reads: open, Fill first (set by hand), Holds fable (registry), Paused, stale, an Ultra with no 5 h window, no forecast.
The steering test sets Fill first on the page, reads it back with `claude-account mode --json` and `rank --lane bulk --json` (reason `drain`), then clears it.

## What was compared

The owner's reference `01-hotel-board-statcards-dark.png` and DESIGN.md "Components", against `accounts-3-dark.png` and `accounts-8-dark.png`.

| Round | Finding | Change |
|-|-|-|
| 1 | Panels were one flat surface; the reference (and StatCard) separates a shell with its header from an inset body | Shell with header (name, plan, mode, seats) and an inset body one surface step down |
| 1 | With 8 accounts the header strip ran 200 px past the viewport | The meters wrap inside their own group; counts and Live stay on the first line |
| 1 | The empty KPI drew a row of zero-height bars | No bars when no window has a figure; the figure shows a dash with the KPI's own reason |
| 2 | A mode read "until the reset" with no time | "until the reset, Sun 05:11" |

Not done: a subagent review with `basalt-design-reviewer` (not installed); the owner's verdict on the live page is asked for after the deploy.
