# Console: the header strip, graphite meters and the app icon

Screenshots from `tests/e2e/screenshots.e2e.ts` (`make e2e`), named `<viewport>-<theme>-<screen>.png`. `desktop-xl` is
1800×1200, `desktop` 1280×800, `phone` 390×844. Screens: `strip` (the header closed), `strip-account` and `strip-host` (each
popover open; the host one with the pointer on the Load chart, so its figures read that minute and not "now"), and
`sidebar-flow` (the logo slot, 1800×1200 pair).

## What changed

- Every strip meter (subscriptions, load, memory, swap) is graphite; warn from 75 % and bad from 90 % of its ceiling
  (`meterTone` in `kit/tone.ts`, one rule for the strip, the Issue page's quota bar and `/kit`). DESIGN.md's Rules say so.
- The subscription popover is one line per window (label, bar with its figure, reset time); the host popover keeps the
  three 24 h charts with their ceilings in the figure (`6.2 / 60`) and the top five processes, and drops the note lines and
  the history sentence. Its charts are graphite.
- The sidebar logo is the app icon, `/icons/icon-192.png`, the metallic tile the installed PWA shows (the flat `mark.svg`
  is the browser tab's favicon only).

## What I compared, and against what

The owner's reference images (`design-refs/console` in the factory's home directory) and basalt-ui's `basalt-design` skill
and reviewer are **not on this machine**, so nothing was compared against them. Each shot was judged against
`apps/console/DESIGN.md` ("Rules", "The frame", "The target") and the previous round, by the lead; a reviewer subagent
read round 2's boards against DESIGN.md and the owner's words.

A red Load bar in the first round's shots is the real host being busy at capture time (the load ceiling is 60; the host
averaged 80 to 190 that evening): the bad tone working. The seeded readings are in `tests/e2e/frame-strip.e2e.ts` (normal
load: every bar graphite; 80 % of a week: warn; load 57 of 60 and an account at 95 %: bad) and `test/strip.test.ts`.

## Review rounds

| Round | Findings | What changed |
|-|-|-|
| 1 | No P0. P2: the swap ceiling read "/ 75" without its unit. The popovers fit without scrolling at 1800×1200 (host ends near y 533) and scroll inside their max height at 1280×800 | "/ 75 %" |
| 2 (reviewer) | No P0. P1: the host popover's figures read as a contradiction of the header (3 against 12.1) — they are the point under the pointer, marked "at 08:48"; the shot pins it. P2: the dark tile of the icon merged into the sidebar; the host meters' gaps were tight; the phone's second row overflows by one meter | a hairline ring on the logo; wider gaps from 1280, narrower bars on the phone |
| 3 | No P0, no P1. The icon has an edge in dark; the gaps read as groups; on the phone the row still scrolls sideways by about one meter (it is a scroller by design, `no-scrollbar`) | none |

Open, not chased: the Flow StatCards' blue sparklines and the sidebar's blue dots are accent colour outside the strip (the
StatCards are the Console's colour moments); the strip writes "62%" and the popover "62 %"; the light chart areas show day
gridlines.
