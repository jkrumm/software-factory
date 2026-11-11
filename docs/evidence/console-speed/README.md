# Console speed: no blocking version reload, skeletons on every route, fast artifact open (Issue 659)

The owner's words (review of Console v1): Needs you "takes time to load: This Console is older than the server -
updating"; "opening a review item takes time"; "we could use Skeleton components to render more nicely".

## Measurement

Taken on the mini against the live Console listener (`:7795`, and through the tailnet door), with Chrome (DevTools
Protocol) and `curl`. The MacBook's own link to the mini is not measurable from the mini: the numbers below hold the
server, the payloads and the request order, not the owner's network. Sizes are bytes on the wire (`br`) and decoded.

### Before (the Console deployed on 2026-11-11, load average under 3)

First load of `/needs-you`, nothing cached but the HTTP cache of the bundle:

| Call | Started at | Took | Wire / decoded |
|-|-|-|-|
| `/v1/needs` | 117 ms | 248 ms (29 ms on a warm load) | 0.7 KB / 1.4 KB |
| `/v1/flow` | 148 ms | 302 ms | 9.3 KB / 38.9 KB |
| `/v1/accounts`, `/v1/machine` | 148 ms | 167, 209 ms | 0.6, 0.2 KB |
| `/v1/host` | 150 ms | 157 ms | 24 KB / 167 KB |
| **`/v1/issues?state=all&limit=500`** | 151 ms | **873 ms** | **57 KB / 551 KB** |
| `/v1/since` | 151 ms | 255 ms | 0.7 KB / 1.8 KB |
| `/v1/chain` | 153 ms | 193 ms | 13.5 KB / 104 KB |
| `/v1/artifacts?limit=200` | 245 ms | 73 ms | 11.5 KB / 53 KB |

- First content (the first Needs-you card in the DOM): **371 ms cold, 155 ms warm** (a warm load paints the persisted
  snapshot). Eleven `/v1` calls in the first 250 ms, so the one that paints (`needs`) waited behind ten others in the
  server: 248 ms for a 1.4 KB answer that takes 14 ms alone.
- The 551 KB list of every Issue was fetched **twice as often as it was used**: the Needs-you screen asked for it (to
  look up the title of the Issue a waiting item belongs to), the palette asked for it on idle, and the stream refetched it
  on every Issue change while the palette sat closed.
- Opening a review (`/v1/artifacts/<id>`): 314 KB decoded, 34 to 128 ms on the loopback, started only when the card
  opened, with a text "Loading" in its place; the page behind "Open the full page" started its chunk (190 KB) and then its
  read after the click, and the Issue named in its header a third request after that.
- The banner: the contract's objects are strict, so a server that only **added a field** failed the parse (`ShapeError`)
  and the screen said "This Console is older than the server - updating" until the new service worker was fetched,
  installed and the page reloaded.

### After (this change, built and served against the same live data)

- First paint of Needs you is its skeleton at **137 ms** in the run on the loaded host (load 75 to 115 during the
  run, so the request timings are 4 to 20 times the idle ones and are not a comparison); content follows the `needs`
  answer. A warm load is unchanged (the persisted snapshot), 155 ms before.
- Title lookup for Needs you: `/v1/issues?state=open&limit=500`, **34 KB decoded, a sixteenth of the 551 KB**.
- The 551 KB palette list and the artifact list are requested **2.5 s after the first paint** (when idle, behind the
  palette chunk) instead of with it, and are watched only while the palette is open: the stream no longer refetches them.
- A hover or focus on a review card starts the artifact read and the page chunk; `speed.e2e.ts` holds the read back for a
  second after the hover, clicks after it arrives, and counts the frames that contain a skeleton: **0**, both for the open
  card and for the page behind "Open the full page".
- An answer with an unknown extra field is read as it is (a test serves one), the new bundle is fetched in the
  background and loaded at the next navigation to another screen, when the tab is hidden or after 45 s without input.
  An answer that does not match at all shows the skeleton, never the banner (a test serves one), and says so only after
  20 s without the new bundle.

Post-deploy numbers (the deployed Console, same calls) are added to this file after the deploy.

## Design loop (`apps/console/DESIGN.md`, "How a screen is built")

Each screen's loading state at 1800x1200 dark and light, 1280x800 and 390x844, shot by `tests/e2e/speed.e2e.ts` (all
`/v1` reads held back), compared with the same screen loaded (`desktop-xl-dark-*`, `phone-dark-*` of `screenshots.e2e.ts`)
and with the owner's three references (`design-refs/console`: hotel board with StatCards, fleet dashboard with a counted
sidebar, StatCard anatomy). The question each round: would the content arriving move anything.

| Round | Looked at | Findings | Changed |
|-|-|-|-|
| 1 (lead) | needs-you, flow at 1800 dark against the loaded screens | P1: no line for the page note (content jumped 24 px); P2: Needs-you cards 92 px against 98 and 72; one board column width for six; stat cards matched at 273 px | `PageHeader loading` holds the note; Needs-you cards 98 and 72 px; the board's own column template and card heights |
| 2 (reviewer subagent from `basalt-design-reviewer.md`, 24 shots, 11 loaded shots, 3 references) | all six screens, four viewports, both themes | P1: the "Since you were here" digest 112 px against 310 (list jumped 200 px), phone 168 against 390; the phone strip's second row (28 px on every phone screen); the Issue page's facts row, tabs and aside structure; Improve target tiles one block against five and the card rows 273 against 290/272; Chain canvas and Schedule one slab. P2: artifact column and comments panel, light-theme panel fill, the sidebar's counts arriving. P3: references fit (graphite, no pulse, 273 px StatCards against the reference's about 265) | The digest takes the height the band had on the last visit; the phone strip reserves its second row; the Issue skeleton restructured; five target tiles and 290/272 rows; Chain canvas plus Schedule block; artifact panel 4 cards and a composer slot, one fill step darker |
| 3 (reviewer, same agent, new shots) | same | **No P0 or P1.** P2: the digest fallback 232 px against 310 for a first visit; the Issue offsets (a divider, 43 px, a third aside block); 16 px under each Improve heading; Chain canvas 816 against 778 and the phone's two-line subtitle; artifact column 644 against 708 (padding inside the cap) | Fallback 310; the Issue divider and the third block removed; 28 px under Improve headings; Chain panel 199 px; column cap 708 + padding; board header 8 px; comments header, subtitle and composer position |
| 4 (reviewer) | all shots again | No P0 or P1. P2: the Issue page's stat row 30 px (phone 36 px) late, the phone Chain canvas 78 px short. P3: the artifact comments' first card 18 px late, the Chain panel 12 px, the second Issue aside block 25 px early | The Issue skeleton's text block 64 to 30 px and its aside gap; the phone Chain canvas 480 px; the comments subtitle gap |
| 5 (reviewer, last) | all 24 skeletons, both themes | **Light pass clean.** Dark pass: no P0 or P1, one P2 left: the phone Chain's title note wraps to two lines on the loaded screen, so the select bar and canvas started 43 px early. P3: Attempts block 24 px early (Issue), Chain panel 12 px late, Needs-you first card 7 px early | The phone Chain's loading note is two bars (about 23 px of the 43 px); the rest is left for the owner's review |
| Not taken | | The sidebar's Kinds and Projects sections and their counts arrive with the data (the sidebar lives in the loaded screen, not the skeleton); the Needs-you digest's timestamp slot; the phone Chain's two-line subtitle bar | A first visit guesses the digest's height; everything after remembers it |

Files: `<viewport>-<screen>` for `skeleton-desktop-xl-dark`, `skeleton-desktop-xl-light`, `skeleton-desktop-dark`
(1280x800) and `skeleton-phone-dark`, each of `needs-you`, `flow`, `chain`, `improve`, `issue`, `artifact`.
