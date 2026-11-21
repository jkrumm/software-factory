# The Console's design

The brief every Console change is built and reviewed against. It exists because v0 met every functional acceptance and
still read as generated: the owner's review of 2026-11-09 found every screen built without care. The
words are `docs/language.md`'s; what the Console may do is `AGENTS.md` "The Console listener".

## What v0 got wrong, never again

- Built and reviewed at 1280×800. The owner works at **1800×1200**; the screens sat in a narrow column and wasted half of it.
- Nothing was a link: an Issue card did not open its Issue, a count did not open Flow, a project was a dropdown.
- Numbers as bare text where a chart says more (host load, KPIs against target), and popovers that were unformatted dumps.
- Domain words with no explanation (an Errand, Checking): a stranger, and the owner, could not tell what they meant.
- Generated-looking decoration: a coloured left bar on cards and blocks, boxes inside padded boxes, borders for depth.
- Interactions that were half there: a passage could not be selected to comment, an annotation could not be edited or
  deleted, the palette found commands but not Issues.
- The page went stale: Needs you stayed empty until a hard reload.

## Direction

Set here once, so no lead stops to ask for it.

- **Product.** The place where one developer sees what needs him, what his agents are doing, and how well his factory works.
- **Character.** Exact, watchful, unhurried.
- **World.** A plant's control room on a night shift: instrument panels, status lamps, the shift log.
- **Moments.** The StatCard row of the Overview (live figures with their trend), the Chain graph, and Improve's KPIs against
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
| Width | Working screens (the Overview, Chain, the Issue page, an artifact) fill the content area. Only running prose caps at about 76ch, with side panels using the rest |
| Density | 13 px in rows and cards, 15 px titles, 4 px spacing scale; tabular figures for every number (set once on `body`); an uncounted value reads as a dash with its reason, never 0 or None |
| Depth | Surface steps (canvas, paper, panel) and one faint shadow scale, never borders for depth; hairlines only between rows |
| Type | Nunito Sans, JetBrains Mono for ids and times; headings semibold with tight tracking |
| Motion | Short, on state change only, honours reduced motion; numbers may roll when they change |

## The frame

- **Sidebar.** The logo slot is the mark on its blue tile (`/icons/mark.svg`, which fills its box; no ring), then the wordmark "Factory" at the top. The global nav is compact: icon, label, a count, and the
  key that reaches it (`g o`, `g n`, …) shown on hover in the count's place, so a label never truncates under both. It
  follows the owner's day: Overview, Needs you, Chain, Projects, Artifacts; then a quieter group under "How it runs"
  (a hairline on the collapsed rail) with Improve, Throughput and Accounts. Overview is active on `/` only; a screen stays active on
  its own pages (a project's tabs under Projects). The phone's tab bar holds the first group; the second is in the palette.
  Under a hairline, **the page's own section**: the Overview's projects and origins as toggles, each with what is
  open behind it as three small figures (a lit lamp and the Running count, an hourglass and the Paused count, a queue icon and the Ready count, a lock and the Held count; never a closed
  Issue, and none at all when nothing is open), Needs you's kinds, Chain's projects, Improve's window. Collapsible to icons.
- **Header strip.** One line from 1280 up, wrapping to two below. In order: counts (Running, Paused, Ready, Held, Checking, each a link to
  the Overview filtered to it); one meter per subscription (graphite until 75 % / 90 %, then warn / bad; popover with the used share per
  window and its reset time); host meters for load, memory and swap (same rule; popover with the 24 h charts and their
  ceilings and the top five processes); Live (a dot, the word, `N stale` and `updating` when they are true, and `build 3 h ago` from 1536 px; popover with
  the stream's state, the last event's age, the server's version and uptime, the build and the update, and the stale reads). Under the strip, only when
  true: a stuck update (two minutes, one button) and the age of the screen's own data once it is older than its poll interval.
- **Everything that names a thing links to it.** An Issue title or an artifact anywhere opens it in the **peek**, a panel on
  the right of the page you are on (below); a modifier-click, "Open full page" in the panel, or a link on the Issue's own
  page opens the page; a project opens its page (`/projects/<name>`; the Overview's own filter stays a toggle in the sidebar); an origin links out to its source (the GitHub issue, the alert).
- **The palette** reaches every navigation target: an Issue by title or by number (a number not in the loaded list still
  opens it), a project by name, an artifact, a collection and every screen. On an empty query it lists what was visited
  last (Recent), then the actions on the thing in view (This page: copy its link, copy the `factory` command that shows
  it, open it in the Chain, answer it when it waits on the owner, pin a collection), then the recently active Issues and
  the commands. Each row has an icon, the highlighted match, a muted reference and a kind column; it shows each command's key.
- **Keys** (`lib/shortcuts.ts`, the one list; `?` shows it as an overlay by group). `g` then a letter opens each screen
  (`o n c p a i t`); Mod+K the palette; `/` focuses the page's filter (its sidebar section) and searches where a page has
  none; Escape closes the peek or a popup first, then goes back from a page of one thing; `j` and `k` move through the
  rows a page marks (`data-keynav`), Enter opens one; `[` and `]` step a chart's window shorter or longer (the Overview's
  trend, Improve, Throughput). Every key goes through `@tanstack/react-hotkeys` and shows in its display format; none
  fires inside a text field.

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
| SeatBadge | The seat of an Issue's lead as two or three mono letters (tier H, S, O, then effort L, M, H, X, XX for max: `SH`) between the Issue's number and its state, on every card, row, table row, Chain node and Needs card; solid for the seat the current attempt started on, dashed and muted for the one it will start on; the words ("Haiku, high effort — lead role", "Will start on …") are its tooltip, never a model id; none when no seat is known |
| IssueCard / IssueRow | Card, built like a StatCard: the shell holds a header (KindIcon, project chip, the Issue number in mono, the origin as a muted word only when it is not You, a Lozenge where no column already says the state) and a footer (the wait or queue reason with its icon, the age in mono); the title sits alone in the inset body one surface step below, 13 px clamped to 3 lines; the whole card is a link; ⋯ on hover swaps with the Lozenge. `compact` (the Chain's node) clamps the title to 2 lines and the reason to 1. A plan row has no number and no age. The row is one dense line from 40 rem: icon, number, title, project, Lozenge, reason, age |
| SinceRow | One thing that happened, as a compact line with no box: an icon tinted by its tone for what happened, the Issue number in mono, the title clamped to one line, the project, the age. It is a button, not a link: hovering or keyboard-focusing it opens a popover to its side (below on a phone, where a tap opens it) with the full title, what happened, the outcome and the links; Escape closes it |
| Peek | A right-side panel over the page it was opened from, up to 52 rem wide (the whole content area on a phone), on the `popover` surface step with the overlay shadow, never a border or a scrim. Its header is a mono tag ("Issue 12"), "Open full page" and a close button (tooltip "Close (Esc)"); the body scrolls on its own and holds the Issue's or the artifact's own view in its narrow form (the properties under the tabs; the comments under the document). Not modal: the page behind stays live, so another card swaps what the panel shows. Focus moves in on open and back to the link that opened it |
| PropertyList | A definition list: a small label above its value, three columns from 40 rem; a missing value reads "None", muted |
| Section / Fold | A section is a heading, a rule and space, never a box; a Fold is a full-width header button with a caret and a count |
| StepRail | One row per event or step: icon, words, a duration bar scaled to the longest, time on the right; a failure is red with its line |
| Meter, Sparkline, MiniBars | Hand-drawn SVG on tokens, hover tooltip, no animation. A Meter is graphite, warn from 75 %, bad from 90 % (`meterTone`) |
| InfoHint | A small ⓘ beside a domain word; its text is that word's definition generated from `docs/language.md`, never retyped |
| EmptyState, Skeleton | One sentence and an icon tile. A skeleton is a quiet block at the final height of what it stands for (`components/skeletons.tsx` holds one per screen, built from the kit's `Skeleton`: a collapsed Needs-you card is 72 to 98 px, a StatCard 273, the trend chart 330, the artifact's comments panel 24 rem), so nothing jumps when the content arrives; the screen is `aria-busy` and named. It never reads "Loading" as text |

## The peek

The decision of Issue 664: a **side panel, not a modal**. A centred modal hides the page it was opened from and wants a
click out; the panel leaves the page (and the Chain graph) readable beside it, lets the next card swap the panel in one
click, and keeps the working screen where it was.

- **Address.** `?peek=issues/<n>` or `?peek=artifacts/<id>` on any page, with `peekTab` (the Issue's tab) and `peekRevision`
  (the artifact's). A reload or a shared link restores it. Navigating to another page drops it.
- **One handler.** A plain click on any link to `/issues/<n>` or `/artifacts/<id>` opens the peek (`components/peek/host.tsx`),
  so no screen wires it and a new link gets it free. Not intercepted: a modifier or middle click, a link with a `target`
  or `data-peek="off"`, a comparison (`compare=`), and every link on the Issue's or an artifact's own page (it is already the
  full view). The palette still goes to the page.
- **History.** Opening from a closed panel pushes one entry; swapping replaces it. Escape, the close button and the
  browser's back all close it, and Escape and the button step back the one entry, so the list is exactly as it was: the page
  underneath stays mounted, keeping its scroll and filters. Escape belongs to an open popover, the
  palette or a menu first, and in a field it only leaves the field.
- **Narrow form.** The views do not size to the viewport inside it: the Issue's properties stack under the tabs, the stat
  figures take two columns, the artifact's comments stack under its document.

## Rules

- The page never scrolls sideways, at any viewport. Shell's `main` clips the x axis; only a container made for it (the Overview
  list's table, a carousel) scrolls sideways, inside itself. Text that cannot break wraps anywhere.
- A meter is graphite; it takes the warn tone from 75 % and the bad tone from 90 % of its ceiling, and no series colour
  otherwise. Colour in the chrome is state only.
- No coloured left bar on a card, a block or a quote. No gradient, no glow, no emoji.
- Colour carries state only through the tone map; text is never in a series colour. Load the `dataviz` skill before any
  chart; every chart has a hover tooltip and a table or numbers beside it. Raw colours fail
  `apps/console/test/no-raw-colour.test.ts`.
- Every card and row is a link: pointer cursor, hover and focus states, the keyboard reaches it.
- Times are relative with the absolute time on hover. An origin is a word plus its source.
- Every domain word a stranger would not know (Errand, Decision, Judge, quarantined signal, Held, Checking) carries an
  InfoHint.
- The page never goes stale: an event invalidates the queries, a reconnect refetches, a persisted snapshot never hides
  live data.
- **A new bundle never blocks a screen and never shows a banner.** The service worker updates in the background; the page
  loads the new bundle at the next navigation to another screen or when the tab is hidden, never after a stretch without
  input (a quiet tab is someone reading), never while something is typed, and at once only for a screen that has no data
  until it does. An update reload keeps the reading position (`lib/scroll-keep.ts`: the containers marked
  `data-scroll-restoration-id`, stored by address before the reload and put back once the data has rendered). A screen that cannot read an answer
  because the server is newer shows its skeleton, not words; only after 20 s without the new bundle does it say so. An answer
  that only adds a field is read as it is.
- **Every route renders its skeleton at once** (Needs you, the Overview, Chain, Improve, an Issue, an artifact, an open card's
  body), and every link to an Issue or an artifact warms its data and its code on hover and focus (the route's loader, run by
  the router's intent preload; the Needs-you cards do the same for a review's artifact and a Decision), so opening it after a
  hover renders with no skeleton at all.
- Fast: routes split, lists over 100 items virtualised, the graph and chart code loaded only where used, interaction
  answers under 100 ms. A screen's first paint reads only what it shows: the 550 KB list of every Issue is the palette's alone
  (fetched when the page is idle, watched only while the palette is open), and Needs you reads the open Issues' cards for
  titles.

## The screens

Each screen of the navigation answers one question, shown under its title (`purpose` in `lib/screens.ts`;
`test/overview.test.ts` fails when this table and the code differ):

| Screen | The question it answers |
|-|-|
| Overview | Where does the factory stand right now, and what needs me first? |
| Needs you | What wants my answer, my review or my hands? |
| Chain | What depends on what, and what holds the next step back? |
| Projects | How is each project doing, and what runs, ships and comes next in it? |
| Artifacts | Which Concepts, Specs and Reports are there to read or to judge? |
| Improve | Is the factory getting better against its targets, and where does it fall short? |
| Throughput | Is the host the limit, and what holds the queue back? |
| Accounts | Will each subscription be full at its reset, and if not, why? |

- **Overview** (home, `/`; it was Flow, and `/flow` redirects here with its filters): a band of four panels first, left
  to right as the owner reads them: what needs him (the count and the three open longest, each opening Needs you),
  production (the projects with an open incident Issue, red; how many ships are Checking), what shipped in the last 24
  hours by project, and the host in one line (load, memory, swap on the strip's meter rule) with the queue's binding
  reason (the reason kind keeping the most not-started Issues out, its count and the first one's message, and the queue's
  state when it paces or drains). Then the stat row (running, paused, not started, shipped this week, each a StatCard
  with its sparkline), the trend chart (its window control is 24 h, 7 d, 30 d, opening on 7 d by the hour; 24 h and 7 d
  are by the hour, 30 d by the day), the project digests, and under them the list of Issues a filter opens: a sortable
  table, collapsed until a word, project or origin is picked, with a link to the Chain. There are no state columns; the
  Chain is the view of the work. Regressions stay on a project's own page: the band reads only what the Overview already
  loads (the flow model, the needs, the host meters).
- **Needs you**: a "Since you were here" band on top. Its head says since when, in words; each category that has something shows a
  figure, its label with an InfoHint, and one plain sentence of what happened and whether it wants anything from the owner;
  an empty category is absent, and what he may act on (Regressed, Incidents, Dropped) reads first. Its entries are SinceRows, never cards, and the detail lives in their popover. Then the checkpoints, project first and then title. A Decision
  shows its options as cards: the recommendation marked with its reason, cost and consequence per option, free text last.
  An Errand says what it is. A quarantined signal shows where it came from, when, and a link to its source.
- **Projects**: one table on TanStack Table (`components/project/table.tsx`, the logic in `lib/project-table.ts`), one row per project in the owner's Herdr groups, busiest first, every figure from the one read `GET /v1/projects`. Each column answers one question with an in-cell visual and its figure right-aligned: Now (a `SegmentBar` of running, paused, ready, held and checking on a scale shared by the rows; Held and Checking at half strength beside the part of their tone), Shipped 7 d (an hourly compact `Sparkline` and the count), Last ship, Cycle and Queue wait (medians with a trend arrow against the 7 days before, lower is good), Production (the lamp: bad for an open incident, warn for a regression in 7 days, accent while Checking, faint when quiet, with the age), Hygiene (probes clean of run, the oldest finding's age), Plan (a graphite meter of rows done; progress, never a warn tone), Leads (running of the seats the host admits). Sort on every header, a name search and quick filters (Red, Hygiene gaps, Moving, Idle), Groups or Flat, Compact (26 px rows: 32 projects in six groups fit 1800x1200) or Comfortable, columns to hide; the choices but not the filter stay per browser. Sticky header and name column; a row is the Tab stop with the arrows, Enter and a click open the project, hover or focus previews its digest. Below 40 rem each row is a card with the same cells. A project's page reads top-down and fills the width. Its header holds the name, a switcher between projects (a popover that keeps the tab that is open; the sidebar has no project list) and the links into the Overview, Chain and Artifacts with `?project=`, then the tabs. The project's own address is the first screen, which at 1800×1200 answers four questions with no scrolling and tells nothing twice: is it healthy (a band of three lamps with one sentence each: production, the checks, the project's files), what moves now (Running and Paused with the reason, five each), what is next (Ready and Held, five each, and the plan rows no Issue is on yet) and what shipped (a StatCard with the hourly bars of 7 days, then the newest five as SinceRows). A list longer than five ends in a count that opens its tab. The rest is a tab with its own address and its own reads: Work (every open Issue, sortable), Plan (every row with state, reason and progress), Shipped (production, then the last 7 days by day), Hygiene (each probe with its last run, the newest pass's findings and how each ended, earlier passes in a Fold) and Setup (`project.yaml` as a form with each key's meaning from the schema's descriptions and the raw file behind a toggle, then the monitors the door routes to the project).
- **Issue**: a header (title, project, KindBadge, Lozenge, age, actions), a PropertyList of the facts, tabs for overview,
  activity (StepRail of the event log in words), evidence and checkpoints; a right panel with properties and the chain
  around it.
- **Chain**: the graph fills the viewport on a canvas step, nodes are 320 x 144 IssueCards (an Issue opens its page; a plan
  row is the same card on a dashed outline, "Not filed yet", with its "Not before" date); a blocked edge is solid warn and
  labelled "blocks", a done one dashed and faint, a legend names them. An edge between two cards on one line is one horizontal segment (`lib/chain-layout.ts` straightens the dagre layout and gives each blocker of a card its own port, the level one at the middle; a card with many blockers draws the lines without labels). Every card ends in a reason line (the wait, the date, or "Waits for ..."). **A chain of more than 60 nodes
  opens collapsed** (`lib/chain-collapse.ts`): every open Issue, the plan rows that may file now (20 per project), and the 6 newest
  closed Issues beside them are cards; the rest of a project's plan is folded into **group nodes** of the card's size, a dashed
  card (a plan row's outline) with the count, "Not filed yet" and its reason ("Wait for open Issues to close", "3 steps from
  filing"), one group per after-depth (four and more share the last), plus one for the closed Issues past the budget. A group is a
  button that opens in place into its rows; "Fold all" closes them. Folds never show an internal id; the page note says how many
  nodes are folded. Smaller chains are drawn whole. Under it a schedule puts every
  row that waits on a date on a time axis from now, with a gridline per day or week (a row past 120 days sits in "Later",
  after a break mark on the axis).
- **Improve**: ordered by what needs attention, not by topic. The seven KPIs in one band, "N of M targets met" beside the
  heading, off target first, then those with no target yet (the sub line says why), on target and not measured, all on one
  4-column lattice of equal StatCards (a shared subgrid keeps header, figure and chart level); Fix commits (the
  stacked-bar card, its weeks and classes in the chart's table); Friction, a ranked list (the top five with a bar, the count and the change
  against the window before, the rest folded); what the loops yielded; the held finding classes; the seats and the reviewers.
  Capacity is not here: its cards and tables live on Throughput, and no table appears on both screens. Every KPI card carries one plain sentence of
  what it means and which way is good, with no click; a KPI with no figure says "Not measured" and why, never a zero. Each
  KPI card has its target as a dashed line and the distance to it, the last window against the one before.
- **Accounts**: the one screen that steers. A strip of the order the lane gives now (the lane switch is a search param; each place carries the rule's reason, a closed account says why), the quota used at reset as the KPI's last six weeks (MiniBars, one hue, the figure and a tooltip per bar), then one full-width panel per account on the card step: header (name, plan, the mode as a Lozenge with its expiry and whether it was set by hand or is the registry's, the seats and the Issues running), one line of forecast in words ("Full Fri 14:00", or "Ends at 38 %, the rest expires Tue 16:00"), then three columns from 1024 px: each limit as a Meter with its reset and below it each lane's verdict; the weekly percent at the last eight resets as bars; and the four intents named by what the owner wants (Fill first, Hold for a model, Pause, Back to normal), each with its expiry choice beside it. One account is one panel under the band, eight are a list of the same panel: no grid of cards, so a lone account never sits in an empty area. Every verdict is the package's (`lib/accounts.ts` words them and builds the bodies); a refusal shows the API's words under the buttons. The strip shows the mode beside an account's meter when it is not normal.
- **Throughput**: a host row of five StatCards leads, numbers first (`host.now`, `host.signals`): CPU busy in percent, memory used and swap used as GB of their totals (a bar of the RAM), memory pressure (the kernel's word, its trend and the minutes above normal), and load against its ceiling with the cores named (`hostFigures` in `lib/throughput.ts`); every card has an InfoHint, the load one says how load differs from CPU percent and why admission uses it. Under it, the three questions the owner asks of the host, each a StatCard (`GET /v1/throughput`'s `answers`, the sentence written by the server): is the host the limit right now (the pressure level with a "The limit" or "Not the limit" pill and its trend), what do queued Issues wait for (the binding reason in hours, per day), what is the largest avoidable cost (the tenant class over its budget, or the open improvement with its before, target and after). The three are the first screen at 1800x1200 and nothing on them needs interpretation. The window (24 hours, 7 days, 14 days) is in the sidebar and the header says where counting started (`config/throughput.json`) and when the window is cut by it. Under them one closed `Fold` per detail, in the order of the answers: CPU, memory, swap, pressure and load charts (the busiest minute of each bucket, memory and load with their RAM and ceiling as the dashed line) with the five largest processes; the queue's hours per reason with the lead time as one segmented bar; memory by class, tenants and projects; the project scorecard; the improvements ledger (a finding from before the epoch reads "Not measured" with its reason). Between the answers and the details, four capacity cards (`GET /v1/capacity-loop`, the window in days: Issues closed, idle allowance-hours with work ready, minutes over the load ceiling, test slot wait), and one more closed fold holds the test-slot steps by peak memory, the `after` edges by shared files, the reaper line and the settings in force. A detail draws nothing until opened. Tables sit on a card step with hairlines between rows and scroll inside themselves when too narrow.
- **Artifact**: a header band (a link back to its Issue with the Issue's Lozenge and project, the title, kind, format,
  author and age, the revision selector, and for a Concept or Spec the verdict as one button whose popover holds the four
  words, each with a one-line consequence under it, and a note; once given it is a Lozenge). Under it three panes in a row from 1024 px (`react-resizable-panels` through `components/ui/resizable.tsx`): the document, Contents (from 1280 px) and Comments, with drag handles between them, sizes a browser remembers (`localStorage`, one layout for three panes and one for two), each folding to a 40 px rail (a button on the pane's header, or a drag below its minimum). Minimums: the document 420 px, Contents 176 px (a 12-character word fits unbroken), Comments 288 px (a readable comment line); defaults Contents 240 px, Comments 384 px (480 px from 1800 px). Under 1280 px the contents are a collapsible bar under the header; the phone and the peek keep the stacked layout. Contents entries never break inside a word, run two lines at most with the full title on hover, step in 16 px per level, and mark the section in view. The document is **centred** in its pane. Reading: 18 px body at line height 1.65 and a measure near 76 characters (Markdown, and every HTML artifact through the Console's reading stylesheet in the frame, which wraps each table in a div that scrolls sideways so it holds the text column), and a header control for smaller (16 px), default and larger (20 px), kept per browser. An HTML artifact also follows the Console's theme (the page sends the resolved theme and its changes; one that declares no colour scheme gets a Basalt dark base in dark, nothing inverted, screenshots never recoloured), keeps every heading and running text in that one centred column, lets a picture wider than the column (a screenshot, a diagram) use the pane up to its own width, and opens a picture in a lightbox on a click (arrows, "n / N", Esc, natural size on a second click). The shared template and `public/frame/frame.js` state which rules the Console enforces; `data-measure` keeps a picture in the column.
  The panel is a surface step with one card per comment on the step below it: author (initial tile, name), a mono relative
  time, the quoted passage as a tinted chip, the words at 13 px, the heading path in mono 11 px without the document's own name.
  The revision shown's comments list first; earlier ones fold under "Previous revision (N)", each marked carried or resolved by
  revision. A write shows at once, marked Sending, and a failed one stays with its reason and a retry. A click on a highlight in
  the document opens its card in edit mode. A card is a button: it brings its passage into view and paints it stronger (a darker fill and an
  underline, so it is not only a step in tint), and its card takes the next surface step with a faint shadow, never a ring
  or a bar; edit (the owner's own) and delete show on the open card, on hover and on focus and work in place. A group heading
  shows only when more than one group exists. A general comment is the box at the panel's foot. Selecting a passage opens
  the comment box as a popover anchored under it (above when there is no room, following the passage through scroll), on
  `popover` and the overlay shadow; below 1024 px it is a bottom sheet. It covers the text under the passage while open;
  the passage itself stays painted. Revisions side by side stay.
  The shared templates follow these rules.

## Copy

The words a person reads are part of the screen, built with its layout. They follow the owner's voice guide (`brain/voice.md`,
"UI and product surfaces") and `docs/language.md`; `bun run --cwd apps/console copy` (in `make check`, with `test/copy.test.ts`)
holds what a script can hold.

- **A label is an action:** verb and object ("Send verdict", "Open the Chain"), never "Submit", "OK" or "Click here".
- **An error says what happened and what to do next:** "The server cannot be reached. This page retries by itself; check that the
  factory is running." Never a bare "Error" or "Failed", never blame.
- **An empty state says why it is empty and gives the first step:** a title and one line under it, or an action. The line is
  the next step, not a second title.
- **Every StatCard has a `hint`** (never `undefined`): the glossary word for what the figure counts. A figure of the host, an
  Issue, a project or the queue (Throughput, the Issue and project pages, the Overview's Shipped) uses a word of "The host" or "The figures
  on a card" in `docs/language.md`, whose definition ends in "What to do:" and the step. An Improve KPI is a measure against a
  target: its hint is the glossary word and its `meaning` line says what it counts and which way is good. A definition longer
  than two sentences carries "Read more in the language guide" in the popover.
- **One word per glossary term:** repo (not repository), artifact (not document), Issue (not item or task), lead (not worker).
  The state words are Running, Paused, Ready, Held, Checking and Planned (`scripts/vocabulary.ts`).
- **Cut what the layout says,** and every word on the voice guide's ban list (leverage, robust, seamless, harness, ...).
- **Not a guide tab.** The concepts are explained in the guide; the Console explains a word where it shows, in two sentences.
- An exception is a line with its reason in `scripts/copy.allow`.

## Done means

1. Playwright's default viewport is 1800×1200; the screenshot suite shoots 1800×1200 dark and light, 1280×800 and
   390×844 for every screen it touches, into the Issue's evidence. `tests/e2e/phone-fit.e2e.ts` proves the phone: no
   element of `main` ends past the viewport, against live-length content (a bare `grid` has an `auto` column that grows
   to its widest child, so `index.css` gives every `.grid` a `minmax(0, 1fr)` column; a `grid-cols-*` still wins).
2. The lead looks at each screenshot next to the owner's reference images (outside the repo, under `design-refs/console`
   in the factory's home directory) and this file, fixes what falls short, shoots again, and writes down what it compared.
3. The rounds' verdicts (each round's findings P0 to P3 and what changed) are in the evidence; the last round is clean
   in both passes.
4. `make check` passes, including the Console's Playwright suite and its copy rules.
