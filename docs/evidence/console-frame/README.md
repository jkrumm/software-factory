# Console frame: sidebar, header strip, palette

Screenshots from `tests/e2e/screenshots.e2e.ts` (`make e2e`), named `<viewport>-<theme>-<screen>.png`. `desktop-xl` is
1800×1200, `desktop` 1280×800, `phone` 390×844. Screens: `sidebar-flow` (Flow with the sidebar and its Projects and Origin
section), `sidebar-flow-collapsed`, `strip` (the header strip closed), `strip-account`, `strip-host`, `strip-live` (each
popover open) and `palette-query` (the palette with a query).

## What I compared, and against what

The owner's reference images (`design-refs/console` in the factory's home directory) are **not on this machine**: the
directory does not exist, so no screen was compared against them. Every screen was judged against
`apps/console/DESIGN.md` ("The frame", "Rules", "The target") and `basalt-design-reviewer`'s rubric, by a fresh reviewer
subagent that saw the shots only. Scores are by eye; `basalt-ui shot` and `metrics.json` were not run (the Console has no
`data-shot` anchors yet).

**Against "The frame".**
- Sidebar: logo slot and the wordmark, compact nav with the count and the key on hover, a hairline, then the page's own
  section (Flow: projects with counts and origins as toggles; Needs you: kinds; Chain: projects; Improve: the window),
  collapsible to icons and persisted. Below `md` the tab bar stays and the filters stay on the page.
- Header strip: one 32 px line at 1280 and 1800 (asserted by Playwright), two lines at 390 (counts, Live and search; then the
  meters). Counts link to `/flow?state=…`. One meter per subscription with a formatted popover; load, memory and swap with
  a popover of the last 24 h as three charts (hover reads one minute across all three) and two top-process tables, from
  `GET /v1/host`; Live with its popover (stream, last event's age, version, uptime).
- Palette: Issues by title or number, projects, artifacts and commands with their keys, the match highlighted.
- Playwright: `frame-sidebar.e2e.ts` and `frame-strip.e2e.ts` cover each link and popover.

## Review rounds

| Round | Score (lowest to highest screen) | Findings | What changed |
|-|-|-|-|
| 1 | 50 to 80 | 6 P1: the memory/swap legend read a hovered value as if it were current; process names truncated with room to spare; the chart tooltip sat on the popover's edge; the palette was 40 % empty; the phone strip wrapped to four rows; collapsed-sidebar badges overlapped the icons. P2: three equal highlights in the sidebar, an accent badge on one nav item only, bare account popover title, wide Live label column, no unit on the account meter | All fixed. Legend shows "now" and the hovered minute marked; 34 rem popover with full names; the tooltip stays inside the chart; palette list `min-h`/`max-h`; the strip takes a `trailing` slot and the phone meters scroll in one row; collapsed counts are dots; one muted count style; toggles get a dot instead of a filled block; Flow's icon is a board, not a funnel |
| 2 | 76 to 91 | No P0, no P1. P2: on 390 the Swap meter is cut off the row and the host popover runs past the viewport bottom; the palette leaves a void under three results; the Flow board's last column is cut at 1280 with no cue. P3: bare "me" label; the collapsed dots are accent-coloured; "Server scenario" in the seeded world | Not changed, listed below |

The logo is out of the design review: the owner rejected the mark from 186a882 and a new one replaces it; the slot is `src/components/logo.tsx`, the one file that renders it.

Open after round 2, not chased: the phone host popover needs a viewport-bounded height with an inner scroll; the palette's
minimum height leaves about a quarter empty under three rows; the account meter's label has no plan or window in it (the
window is in the aria-label and the popover); the sidebar's collapsed dots use the accent. Two honest limits: hover and
focus states are only in the shots the suite opens deliberately (the popovers and the palette), and there was no reference
comparison.
