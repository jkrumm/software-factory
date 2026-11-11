# The Console's design

The brief every Console change is built and reviewed against. It exists because v0 met every functional acceptance and
still read as generated: the owner's review of 2026-11-09 found every screen built without care. The
words are `docs/language.md`'s; what the Console may do is `AGENTS.md` "The Console listener".

## What v0 got wrong, never again

- Built and reviewed at 1280×800. The owner works at **1800×1200**; the screens sat in a narrow column and wasted half of it.
- Nothing was a link: an Issue card did not open its Issue, a count did not open Flow, a project was a dropdown.
- Numbers as bare text where a chart says more (host load, KPIs against target), and popovers that were unformatted dumps.
- Domain words with no explanation (an Errand, Watching): a stranger, and the owner, could not tell what they meant.
- Generated-looking decoration: a coloured left bar on cards and blocks, boxes inside padded boxes, borders for depth.
- Interactions that were half there: a passage could not be selected to comment, an annotation could not be edited or
  deleted, the palette found commands but not Issues.
- The page went stale: Needs you stayed empty until a hard reload.

## Direction

Set here once, so no lead stops to ask for it.

- **Product.** The place where one developer sees what needs him, what his agents are doing, and how well his factory works.
- **Character.** Exact, watchful, unhurried.
- **World.** A plant's control room on a night shift: instrument panels, status lamps, the shift log.
- **Moments.** The StatCard row above Flow (live figures with their trend), the Chain graph, and Improve's KPIs against
  their targets. Colour lives there; the chrome stays graphite.
- **Signature.** The status lamp: a small dot lit only for something live (a working lead, an open stream, a host under
  load), steady, never pulsing.

## How a screen is built

With basalt-ui's design loop, the one procedure for the owner's UIs: the `basalt-design` skill shipped in
`node_modules/basalt-ui/agent/skills/basalt-design/`. Its method applies as written (a concept per screen before code,
`data-shot` anchors with their states, `basalt-ui shot --dist dist` each round into a fresh `--out`, review by a subagent
reading the boards plus `basalt-ui shot detect`, at least three rounds, at most five before showing the owner); its build
laws do not (they are Mantine's; the Console is Base UI and Tailwind on Basalt's tokens). Its `references/anti-defaults.md`,
`stat-tile.md` and `states.md` are read as they stand. The reviewer is not installed here: hand a subagent
`node_modules/basalt-ui/agent/agents/basalt-design-reviewer.md` as its brief, with the round's out dir. Two additions:

- **Score against references, not in a vacuum.** The reviewer sees the round's shots beside the owner's reference images
  and the previous round, ranks each screen against them, and is not told a target score.
- **The owner's taste wins** where it differs: StatCards carry a sparkline or bars and a footer (his reference 03);
  working screens use the full width at 1800×1200, which `shot` does not capture, so the Playwright screenshots stay.

## The target

| | |
|-|-|
| Primary viewport | 1800×1200, dark and light. 1280×800 must not break. Phone 390×844 |
| Width | Working screens (Flow, Chain, the Issue page, an artifact) fill the content area. Only running prose caps at about 75ch, with side panels using the rest |
| Density | 13 px in rows and cards, 15 px titles, 4 px spacing scale; tabular figures for every number (set once on `body`); an uncounted value reads as a dash with its reason, never 0 or None |
| Depth | Surface steps (canvas, paper, panel) and one faint shadow scale, never borders for depth; hairlines only between rows |
| Type | Nunito Sans, JetBrains Mono for ids and times; headings semibold with tight tracking |
| Motion | Short, on state change only, honours reduced motion; numbers may roll when they change |

## The frame

- **Sidebar.** The logo slot is the app icon, the metallic tile the PWA shows (`/icons/icon-192.png`), then the wordmark "Factory" at the top. The global nav is compact: icon, label, a count, and the
  key that reaches it (`g n`, `g f`, …) shown on hover. Under a hairline, **the page's own section**: Flow's projects and origins as toggles, each with what is
  open behind it as two small figures (a lit lamp and the running count, an hourglass and the pending count; never a closed
  Issue, and none at all when nothing is open), Needs you's kinds, Chain's projects, Improve's window. Collapsible to icons.
- **Header strip.** One line from 1280 up, wrapping to two below. In order: counts (working, waiting, queued, each a link to
  Flow filtered to it); one meter per subscription (graphite until 75 % / 90 %, then warn / bad; popover with the used share per
  window and its reset time); host meters for load, memory and swap (same rule; popover with the 24 h charts and their
  ceilings and the top five processes); Live (a dot; popover with
  the stream's state, the last event's age, the server's version and uptime).
- **Everything that names a thing links to it.** An Issue title anywhere opens the Issue page; a project opens Flow
  filtered; an origin links out to its source (the GitHub issue, the alert).
- **The palette** finds Issues by title or number across projects, projects, artifacts and commands, each row with an icon,
  the highlighted match, a muted reference and a kind column; it shows each command's key.

## Components

Built in `apps/console/src/components/kit/`, shown together on a `/kit` route, each with a clean props API on Basalt
tokens so it can move to basalt-ui later (NL4). Evaluate the MIT shadcn registry components of tuffui (`stat-grid`,
`agent-question`, `tool-approval-queue`) before building one: take one when it works on Base UI, rebuild its anatomy when
it does not.

| Component | Anatomy |
|-|-|
| StatCard | **Header**: an icon tile, a title, a subtitle naming the comparison ("against the last 7 days"), a ⋯ menu. **Body**: a large tabular figure, a delta pill (↗ +4, good or bad by `higherIsBetter`), one sub line, then a sparkline or bars with three x labels (start, now, end), dashed where it is a target or the future. **Footer**: two key-value pairs. Card and body are separate surface steps |
| Lozenge | A state as text on a 12 % tint of its tone; the tone comes from an explicit map, never from the words |
| KindBadge | The Issue's kind (feature, bug, incident, chore, docs) as an outline badge with its icon; `KindIcon` is the icon alone with the kind as its name and tooltip (cards and rows) |
| IssueCard / IssueRow | Card, built like a StatCard: the shell holds a header (KindIcon, project chip, the Issue number in mono, the origin as a muted word only when it is not You, a Lozenge where no column already says the state) and a footer (the wait or queue reason with its icon, the age in mono); the title sits alone in the inset body one surface step below, 13 px clamped to 3 lines; the whole card is a link; ⋯ on hover swaps with the Lozenge. `compact` (the Chain's node) clamps the title to 2 lines and the reason to 1. A plan row has no number and no age. The row is one dense line from 40 rem: icon, number, title, project, Lozenge, reason, age |
| SinceRow | One thing that happened, as a compact line with no box: an icon tinted by its tone for what happened, the Issue number in mono, the title clamped to one line, the project, the age. It is a button, not a link: hovering or keyboard-focusing it opens a popover to its side (below on a phone, where a tap opens it) with the full title, what happened, the outcome and the links; Escape closes it |
| PropertyList | A definition list: a small label above its value, three columns from 40 rem; a missing value reads "None", muted |
| Section / Fold | A section is a heading, a rule and space, never a box; a Fold is a full-width header button with a caret and a count |
| StepRail | One row per event or step: icon, words, a duration bar scaled to the longest, time on the right; a failure is red with its line |
| Meter, Sparkline, MiniBars | Hand-drawn SVG on tokens, hover tooltip, no animation. A Meter is graphite, warn from 75 %, bad from 90 % (`meterTone`) |
| InfoHint | A small ⓘ beside a domain word; its text is that word's definition generated from `docs/language.md`, never retyped |
| EmptyState, Skeleton | One sentence and an icon tile; skeletons at the final height so nothing jumps |

## Rules

- The page never scrolls sideways, at any viewport. Shell's `main` clips the x axis; only a container made for it (the Flow
  board, a carousel) scrolls sideways, inside itself. Text that cannot break wraps anywhere.
- A meter is graphite; it takes the warn tone from 75 % and the bad tone from 90 % of its ceiling, and no series colour
  otherwise. Colour in the chrome is state only.
- No coloured left bar on a card, a block or a quote. No gradient, no glow, no emoji.
- Colour carries state only through the tone map; text is never in a series colour. Load the `dataviz` skill before any
  chart; every chart has a hover tooltip and a table or numbers beside it. Raw colours fail
  `apps/console/test/no-raw-colour.test.ts`.
- Every card and row is a link: pointer cursor, hover and focus states, the keyboard reaches it.
- Times are relative with the absolute time on hover. An origin is a word plus its source.
- Every domain word a stranger would not know (Errand, Decision, Judge, held signal, settling, watching) carries an
  InfoHint.
- The page never goes stale: an event invalidates the queries, a reconnect refetches, a persisted snapshot never hides
  live data.
- Fast: routes split, lists over 100 items virtualised, the graph and chart code loaded only where used, interaction
  answers under 100 ms.

## The screens

- **Needs you**: a "Since you were here" band on top (what shipped, what failed, what the Judge settled and the screen
  turned away, what is new, since the owner's last visit). Its entries are SinceRows, never cards, and the detail lives in their popover. Then the checkpoints, project first and then title. A Decision
  shows its options as cards: the recommendation marked with its reason, cost and consequence per option, free text last.
  An Errand says what it is. A held signal shows where it came from, when, and a link to its source.
- **Flow**: a stat row (working, waiting, queued, shipped this week, each a StatCard with its sparkline), then the board
  across the full width; a column header has its count and an InfoHint; IssueCards open the Issue and show its number.
- **Issue**: a header (title, project, KindBadge, Lozenge, age, actions), a PropertyList of the facts, tabs for overview,
  activity (StepRail of the event log in words), evidence and checkpoints; a right panel with properties and the chain
  around it.
- **Chain**: the graph fills the viewport on a canvas step, nodes are 320 x 144 IssueCards (an Issue opens its page; a plan
  row is the same card on a dashed outline, "Not filed yet", with its "Not before" date); a blocked edge is solid warn and
  labelled "blocks", a done one dashed and faint, a legend names them. Every card ends in a reason line (the wait, the date, or "Waits for ..."). Under it a schedule puts every
  row that waits on a date on a time axis from now, with a gridline per day or week (a row past 120 days sits in "Later",
  after a break mark on the axis).
- **Improve**: seven bands, each a Section with full rows of equal StatCards (a shared subgrid keeps header, figure and
  chart level): Against target (a summary strip of one lamp tile per targeted KPI (status, figure, label, target; compact rows below 80rem, two lines on a phone), with "N of M targets met"), Quality, Pace and gates, Spend (all on one 4-column lattice), Fix commits (the stacked-bar card
  beside its class table), Friction (balanced columns in one panel), then the held finding classes. Each KPI card has
  its target as a dashed line and the distance to it, the last window against the one before.
- **Artifact**: a header band (a link back to its Issue with the Issue's Lozenge and project, the title, kind, format,
  author and age, the revision selector, and for a Concept or Spec the verdict as one button whose popover holds the four
  words and a note; once given it is a Lozenge). Under it the document, **centred** in the column left of a 24 rem comments
  panel, running prose capped at 75ch (Markdown and the shared template alike; tables, figures and code fill that measure).
  The panel is a surface step with one card per comment on the step below it: author (initial tile, name), a mono relative
  time, the quoted passage as a tinted chip, the words at 13 px, the heading path in mono 11 px, and the revision only when it
  is not the one shown. A card is a button: it brings its passage into view and paints it stronger (a darker fill and an
  underline, so it is not only a step in tint), and its card takes the next surface step with a faint shadow, never a ring
  or a bar; edit (the owner's own) and delete show on the open card, on hover and on focus and work in place. A group heading
  shows only when more than one group exists. A general comment is the box at the panel's foot. Selecting a passage opens
  the comment box as a popover anchored under it (above when there is no room, following the passage through scroll), on
  `popover` and the overlay shadow; below 1024 px it is a bottom sheet. It covers the text under the passage while open;
  the passage itself stays painted. Revisions side by side stay.
  The shared templates follow these rules.

## Done means

1. Playwright's default viewport is 1800×1200; the screenshot suite shoots 1800×1200 dark and light, 1280×800 and
   390×844 for every screen it touches, into the Issue's evidence. `tests/e2e/phone-fit.e2e.ts` proves the phone: no
   element of `main` ends past the viewport, against live-length content (a bare `grid` has an `auto` column that grows
   to its widest child, so `index.css` gives every `.grid` a `minmax(0, 1fr)` column; a `grid-cols-*` still wins).
2. The lead looks at each screenshot next to the owner's reference images (outside the repo, under `design-refs/console`
   in the factory's home directory) and this file, fixes what falls short, shoots again, and writes down what it compared.
3. The rounds' verdicts (each round's findings P0 to P3 and what changed) are in the evidence; the last round is clean
   in both passes.
4. `make check` passes, including the Console's Playwright suite.
