# Console

The owner's place for decisions, on a phone and a desktop: a Vite + React SPA (Base UI through shadcn, Tailwind 4, Basalt
tokens, TanStack Router, Query and Hotkeys), installable as a PWA. It holds no logic the API could hold. This is the shell:
a sidebar, a one-line header strip, the command palette, and the screens (Overview, Needs you, Chain, Projects, Artifacts, Improve, Throughput, Accounts, and the Issue page).

**Sidebar** (`components/sidebar.tsx`, from `md` up; a tab bar below): the logo slot and wordmark, the eight screens in two groups (Overview, Needs you, Chain, Projects, Artifacts; then Improve, Throughput and Accounts under "How it runs") with their
keys (`g o`, `g n`, `g c`, `g p`, `g a`, `g i`, `g t`, `g s`, shown on hover in the count's place) and counts, then the page's own section. A page fills that section with
`<SidebarSection title>` (a portal into the sidebar's slot, gone when the page unmounts): the Overview's projects and origins,
Needs you's kinds and projects (`?kind=`, `?project=`), Chain's projects, Improve's window. Each is a toggle on a search param, and the page's own
select or switch stays below `md`. Collapsed to icons (14 rem or 3.5 rem, kept in `localStorage` as `console-sidebar`) the
section is hidden, so a page shows its active filters as removable chips (`ActiveFilters`) and Improve keeps its window switch.

**Header strip** (`components/status-strip.tsx`, `components/strip/`): Running, Paused, Ready, Held and Checking (the last one quieter) from `FlowModel.work`, each a
link to `/?state=...`; one meter per subscription from `/v1/accounts`; the host's load, memory and swap with the last
24 h and the busiest processes from `GET /v1/host`; and Live. Each meter and Live opens a popover. Live says `Live`,
`Polling` while the event stream is closed, or `Offline` with the snapshot's age.

**Palette** (`Mod+K`, `components/palette.tsx`, pure logic in `src/lib/palette.ts`): every navigation target (an Issue by
title or by number, a number not in the loaded list included; a project by name; an artifact; a collection; each screen with
its key), the theme and a reload. An empty query lists Recent first (the last 8 Issues, artifacts, collections and projects
opened, `src/lib/recent.ts`, `localStorage` `console-recent`), then This page (actions on the thing in view, a peek winning
over the page under it: copy its link, copy the `factory` command that shows it, open it in the Chain, answer it, pin a
collection), then the recently active Issues and the commands.

**Keys** (`src/lib/shortcuts.ts`, the one list; `?` shows it as an overlay by group, `components/shortcuts-dialog.tsx`):
`g` then `o n c p a i t` opens a screen, `/` focuses the page's sidebar section or searches, Escape goes back from a page of
one thing once no peek or popup holds it, `j` and `k` move through the rows a page marks with `data-keynav` and Enter opens
one, `[` and `]` step a chart's window (the Overview's trend, Improve's days, Throughput's hours). All through
`@tanstack/react-hotkeys`; none fires in a text field.

**Peek** (`components/peek/`, kit `Peek`): a plain click on any link to an Issue or an artifact opens it in a right-side
panel over the current page (`?peek=issues/<n>` or `?peek=artifacts/<id>`, with `peekTab` and `peekRevision`), and the page
underneath stays mounted. One document-level click handler (`PeekHost`) serves every screen: modifier and middle clicks,
links with a `target` or `data-peek="off"`, and every link on the Issue's or an artifact's own page keep going to the full
page. Escape, the close button and the browser's back close it; opening pushes one history entry and swapping what it shows
replaces it, so closing is one step. Escape yields to an open popover or the palette, and in a field it only leaves the
field. The address logic is pure (`lib/peek.ts`); the panel's content is its own chunk. The rules: `DESIGN.md` "The peek".

## Projects

`/projects` is one table on TanStack Table (`components/project/table.tsx`; sorting, filters, stored choices and the lamp in `lib/project-table.ts`) fed by one read, `GET /v1/projects`, which carries every figure and the digest the row previews on hover; one row per project in the owner's Herdr groups, busiest first, a card per project below 40 rem; a row opens `/projects/<name>`, and so does **every project chip** of the Console (Issue cards and rows, Needs you, the Chain's nodes and groups, the digest strip, the palette, Throughput's tables, the Issue page and artifact headers). The Overview's own project filter stays a toggle in its sidebar. The page (`routes/projects.$name*.tsx`, `components/project/`) reads top-down. Its header holds the name, a project switcher (a popover that lands on the tab that is open; there is no project list in the sidebar), the links to the Overview, Chain and Artifacts filtered to the project, and the tabs. The project's own address is the first screen, built for 1800 by 1200 with no scrolling: a health band of three answers (production: incidents, regressions and what is in Watch; the checks: the hygiene probes that found or failed; the project files: a `project.yaml` or plan that does not parse), then Moving now (Running and Paused with the reason, five each), Next (Ready and Held, five each, and the plan rows no Issue is on yet) and Shipped (the hourly bars of 7 days and the newest five); each list ends in a count that opens the tab with the rest, and nothing is shown twice. The other screens are tabs with their own address and their own reads: `/work` (every open Issue, sortable, from the cached `GET /v1/flow` so it is as live as the Overview), `/plan` (`GET /v1/projects/:name/plan`: every row with state, reason and progress), `/shipped` (production and the last 7 days by day), `/hygiene` (`GET /v1/projects/:name/hygiene`: the probe catalogue with each probe's last run, the newest pass's findings and how each ended, the last five passes) and `/setup` (`GET /v1/projects/:name/setup`: the `project.yaml` as a form with each key's meaning from the schema's descriptions, the raw file behind a toggle, and the monitors the door routes to the project). Every tab also reads `GET /v1/projects/:name` (counts, hourly and daily shipped, Watch, incidents and regressions, the monitors). A project the factory has not read is a 404 and the page says so; a work project is shown to the owner only. The words and sums are pure logic in `src/lib/project.ts`.

## Accounts

`/accounts` (`routes/accounts.tsx`, the words in `lib/accounts.ts`) reads `GET /v1/accounts` and holds no rule: the package's state, lanes, forecast, reset ledger and order, worded. It shows the order the chosen lane (`?lane=`, default bulk) gives now with each place's reason, the KPI quota used at reset over the last six weeks (from `GET /v1/kpis`), and one panel per account: plan, mode with its expiry and source, each limit as a meter with its reset, the forecast in words, per lane whether it takes work and why not, the seats, the weekly percent at the last eight resets, and the four intents (Fill first, Hold for a model, Pause, Back to normal) with their expiry. The intents are `POST` and `DELETE /v1/accounts/:id/mode`, two of the listener's fourteen verbs. The strip shows a mode beside the account's meter when it is not normal.

## Overview

`/` is the home screen and fills the content area (no width cap); `/flow`, its old address, redirects here with its search. Each
screen of the navigation shows the question it answers under its title (`purpose` in `src/lib/screens.ts`, the table in `DESIGN.md`).
From the top: the header, the band, a stat row, the trend chart, the digest strip and, under them, the list of Issues a filter
opens, from `GET /v1/flow`, refreshed by the stream like every other screen. There are no state columns anywhere: the Chain is
the view of the work.

**Band** (`components/overview/band.tsx`, pure logic in `src/lib/overview.ts`): four panels, each linking to the screen with its
detail. Needs you: the count and the three open longest (`GET /v1/needs`). Production: the projects with an open incident Issue
(red), the projects that regressed in the last 7 days without an open incident (`regressedOf`, from `GET /v1/projects`, the lamp the Projects table shows) and how many ships are Checking. Shipped in 24 h: done and healed closes of `closedRecently` in the last rolling 24 hours, by project. Host and queue:
load, memory and swap on the strip's meter rule (`/v1/machine`, `/v1/host`, the queries the strip already holds) and the queue's
binding reason, the queue reason kind that keeps the most not-started Issues out, with the first one's message. It reads only queries the Console already holds.

**Digest strip.** Under the trend chart, one card per project with a digest (`GET /v1/projects/digests`, `components/flow/digest-strip.tsx`): the project (a link to its page), the digest's age, the headline, the five counts (done in 7 days, running, paused, ready, held: `counts.work`, read from the Issues, not from the digest), and a button that opens the shipped, next and risks bullets, each citing its Issues by a link. The busiest projects (most working, queued and waiting) come first, in one scrollable row so the charts stay on screen; "Show all N" lays every card out as a grid. Collapsed to the headline and the counts; with `?project=` the strip shows that project alone, opened. No digest, no strip.

**Stat row.** Four kit `StatCard`s: Running, Paused, Not started (Ready and Held together; a line of the Issues at eight daily samples,
`trend` in the model, summed over the stored states a series takes in) and Shipped this week (bars of the done and healed closes per day, against the 7 days before). They
are factory-wide, never narrowed by the filters; each opens `/?state=<word>` (Not started: the whole list, there is no list of Ready and Held together; Shipped: `closed`), the same list the
header strip's counts open. All count Issues, never sessions, by the one definition `workOf` in the contract (`docs/language.md` "Where work stands"), the same as the strip, the sidebar and the project digests; each card carries an InfoHint with that definition in its top right corner. Below `lg` the row scrolls sideways inside itself, snapping per card.

**The list** (`components/flow/issue-table.tsx`, `FlowList` in `routes/index.tsx`). A plain table of Issues under the charts, collapsed to its
heading and one line until a filter is set: `?state=`, `?project=` or `?origin=`. Columns: the number with the kind as an icon, the
title (a link to `/issues/<n>`, opening the peek; a wait's reason or the queue's message under it), the project (a link to its
page), the origin, the state (a Closed Issue shows its outcome) and the age since it entered it. Every header sorts (`aria-sort`);
it opens on what has been in its state longest first (Closed recently: newest first), and the sort is the list's own state, not the
URL's. The heading is the label and count ("Running 3"); "See how these depend" opens the Chain, filtered to the project when
every row is one project's. No state shows every open Issue, then what closed in the last day. The table is not virtualised: a
filter leaves a few dozen rows.

**Trend chart** (`components/flow/trend-chart.tsx`, `GET /v1/flow/trend`): below the stat row, the peak (most Issues at any instant) and the average of one count per bucket, computed by the server from the applied events. Its own frame holds the controls: the count (Running, Paused, Not started, Checking) and the window by bucket (24 h and 7 d by the hour, 30 d by the day; it opens on 7 d; hours in the viewer's zone, days are UTC days). Three windows, one meaning: a Console chart that offers a window offers these.

**Filters.** Projects and origins are toggles in the sidebar (selects on a phone only) and live in the URL
(`/?project=argo&origin=feedback`), so a filtered view is linkable, and the list heading counts what the filters
leave. A sidebar row's figures are its *open* Issues, never closed ones (`openSplits` in `src/lib/flow.ts`): a lit lamp and the Running count, an hourglass and the Paused count, a queue icon and the Ready count, a lock and the Held count (Checking in the hover); a row with none open shows no figure. `?state=running|paused|ready|held|checking|closed` (the stored names of an old link read as the word that replaced them) lists exactly that word's Issues (Checking is its own word and settling is Held) with a "Show all states" link; it never filters the figures. An unknown state is dropped.

**The page never scrolls sideways.** The Shell's `main` clips the x axis (`overflow-x-hidden`), a table too wide for the screen scrolls inside its own container, and text that cannot break (a stat card's sub line, a reason line) wraps anywhere. `tests/e2e/flow.e2e.ts` asserts `document.scrollWidth` equals the viewport width and `main` has no sideways scroll at 1280x800 and 390x844, also with long titles and reasons at 1024.

## Needs you

`/needs-you` opens with the **Since you were here** band, then the checkpoints. The band is `GET /v1/since`: one figure and
label per category (Shipped and verified, Regressed, Dropped, Answered by the Judge, Turned away, New Issues
with its by-origin words, Incidents), a quiet figure when a category is empty, the newest three items of each as compact `SinceRow`s (an
icon for what happened, the number, the title clamped to one line, the project, the age; no card) and a Fold for the rest
the server sent. A row is a button: hovering it, focusing it with the keyboard or tapping it opens a popover to its side
with the full title, what happened, the outcome and the links (the Issue, and for shipped and regressed ones its
verification evidence). When every count is zero it is
one line ("Nothing changed since 09:12"). The categories, labels, tones and words are pure logic in `src/lib/since.ts`.
**The visit marker** lives on the server: the owner's read of `/v1/since` is what moves it (a new visit starts after 30
quiet minutes; inside a visit every read returns the same band), so only this screen calls it, the query (`['since']`)
never polls, is never refetched by the stream (an open tab would keep the visit alive) and never enters the persisted snapshot, and it loads when the screen opens and when the window gets focus, and only while the tab is on screen (a hidden tab that reloads after a deploy waits until it is shown). A
loading band is a skeleton of its height, and an error leaves the band out while the checkpoints show.

The checkpoints are grouped by kind (Decisions, Reviews, Errands, Quarantined signals, each with its count and an InfoHint). Every
card leads with its project, a chip that opens `/projects/<repo>` (the word "App feedback" when it names none), then the
title, the age in the verb of its kind (open, raised, received; the absolute time on hover), a Stale lozenge, and the
Issue's title as a link. Closed, the whole card opens it (the title button is stretched over the card, the links sit above it).
Opened, a Decision says what it is, shows the Judge's note when it passed it on, and lays its options out as cards with the
reversible lozenge, the cost, the reason on the recommended one and the default-if-nobody-answers on the option that is the
default; a recommendation that is a sentence matching no option is a block above the cards with a "Take the recommendation"
button. An Errand says what it is, then its summary, Issue, project, when it was raised and the screen's note. A quarantined signal
says what it is, its source in a person's word and origin, a link to the source (only `http(s)`, `target=_blank`), when it was
received and the screen's note, then Promote and Dismiss.

`?kind=` and `?project=` filter the list (both in the URL; `?item=` stays the deep link, and the deep-linked item shows even
when the filters would hide it). The sidebar has Kinds and Projects, each count reflecting the other filter; collapsed, the
filters are chips; below `md` each has a select.

## Chain

`/chain` draws the dependencies between Issues and plan rows across projects from `GET /v1/chain`: `@xyflow/react` for the
canvas, `@dagrejs/dagre` for the layout (`src/lib/chain-layout.ts`, left to right, a blocker left of the node that waits for it),
loaded as its own chunk so the other screens do not carry them. The route's `loader` imports that chunk and prefetches the chain, so the router fetches both on hover and focus of the sidebar link, and `main.tsx` preloads the route when the page is idle: a navigation from another screen paints the graph in about one frame (7 runs, median 25 ms against 335 ms when the chunk loaded on the click). The page is `<Page full>`: a compact header, then the graph
fills the rest of the height and the full width on a canvas step (at least 28 rem high, 24 rem on a phone), and the schedule
sits under it; the graph fits again whenever the canvas resizes (centred, never above 140 %, so a graph of two cards fills the canvas; on a phone it starts at 90 % at the top left, so the graph is panned, with the zoom controls at the top right). An arrow runs from the blocker into the node that runs after
it. A blocked edge is solid warn and thick, labelled `blocks`; a satisfied one (the blocker has closed) is dashed and quiet,
labelled `done`, and the two arrive on separate handles of the node. An edge is one line (`Dependency` in `graph.tsx`): it turns early and carries its label on the final straight run, so the line runs through the label to the arrowhead; each edge also has an accessible text ("A blocks B"), and a legend in the corner (from `md` up) names both and the dashed
plan row. A node is the kit `IssueCard` at a fixed 320 x 144 (`NODE_WIDTH`, `NODE_HEIGHT`, which dagre reads): an Issue is a
link to `/issues/<n>` with its kind, state, one reason line (its wait reason, "Waits for <blocker>" while a blocker is open, else what its state means, "Closed, no longer blocks" for a closed one) and age; a plan row is the same card on a dashed outline, not a link,
with "Not filed yet" in the header, no number, no age, a Lozenge (Planned, with its reason: "Due to file", "After another Issue" or "Not before <date>") and, when it is dated,
the date, "Not before Mon 16 Nov, 09:00" (the viewer's zone, the UTC instant on hover). An Issue node shows its number. Nodes with no edge
and no date are not drawn: the header counts them ("N more items have no dependencies, so they are not drawn"), and the sidebar's per-project count is the nodes the graph draws for that project (`chainCounts` in `src/lib/chain.ts`, one source for both). `?project=argo` keeps that project's nodes
and every node an edge joins them to, so an edge across projects stays readable. With no edge the graph part says "No
dependencies". xyflow's variables are pointed at the semantic tokens in `src/styles/index.css`.

**Schedule** (`components/chain/schedule.tsx`, the logic in `scheduleOf` in `src/lib/chain.ts`): every plan row with a
`notBefore` under the project filter, with or without an edge, as a marker on a time axis from now to the last date inside 120
days (at least 7 days), day ticks up to 14 days and Monday ticks after, in mono, a "Now" mark at the left. Each row has a chip
(title, project, date, "in 6 days"); a chip that would cover a later date's dot sits above that chip, so every dot's stem reaches its own chip; tick labels thin out to every nth when they would touch, and the first one is left out when it would touch "Now"; a row whose date has passed and is still not filed
is pinned at Now as "due"; a row past the horizon is in the "Later" cell at the right end with its date. The picture is
`aria-hidden`; a visually hidden table lists the same rows for a screen reader. On a phone the band scrolls inside itself.
`tests/e2e/chain.e2e.ts` compares the page with the API on a seeded chain across two projects (`seed-chain.ts`, whose plan dates
are computed from the seed time).

## Improve

`/improve` fills the content area (`Page fluid`). The page is ordered by what needs attention: kit `StatCard`s, one per KPI of `docs/product.md` (the seven `KPI_KEYS` in `packages/contract`, ordered by `KPI_ORDER`), in one band **KPIs** with "N of M targets met" beside it, sorted by `groupKpis`: off target first, then those with no target yet, on target and not measured, then the fix-commit card, which spans two columns where the grid has them. A KPI card's header is an icon,
the label and "Last 7 days against the 7 before"; its figure is `formatKpi`; its pill is the change against
`history[length - 2]` in the unit's words, toned by the target (higher is better for `at_least`, lower for `at_most`, toward
the range for `between`, neutral for a trend or no target); its sub line is the distance to the target in words, or for a KPI with no target yet its `targetSource` (why there is none and when one is due); under it one plain sentence (`MEANING`: what the figure is and which way is good), visible without a click; its
chart is the windows of `Kpi.history` (up to six, none before the counting epoch) as a `Sparkline` with the target dashed (two lines for a range), the line broken
at a window with nothing counted and toned good, bad or quiet by the current verdict; its footer is Target and Counted (a rate names its absolute count first: "58 over 1263 Issues"). A KPI
with no figure (`measured` false: nothing counted in the window, fewer than three samples under a share or a duration, or the source is not there, as quota used at reset without the accounts' ledger) shows "Not measured", no chart, and
says why in the sub line (`Kpi.reason`); it is never a zero. A KPI that is a breakdown and named on the card (`PARTS_ON_CARD`: avoidable touches by kind, Errands by what they needed, the queue wait by capacity, an after edge, a draining queue, production red) lists its `parts` as bars under the sentence, the largest named first. The ⋯ menu opens "What is counted", the KPI's `definition` and, for a breakdown (`Kpi.parts`: queued time by reason, time by state, regressions by cause), one line per part in the KPI's unit, then the figures read beside it (`Kpi.beside`: the asks, the Spec rate, the working share, the dollars per Issue), each in its own unit. The fix-commit card shows the newest
week's total with the change against the week before (fewer is better), `StackedBars` by week (oldest left) with the legend
of cause totals, and "Total in the shown weeks" and "Busiest cause"; the chart's own table holds the weeks by cause. Friction is a ranked list of the kinds that counted anything, most first: the top five in words with a bar, the count and the change against the window just before (`FrictionCount.previous`), the rest in a `Fold`. "What the loops yielded" follows (a row per signal-filing loop and window of 7 and 30 days: passes, signals, Issues and how they ended, median time to close, the kinds filed most; `/v1/loop-yield`), then "Judges checked against what happened" (per judge the answers of the window, how many stood, were too early to say or did not stand, the share and the three newest that did not; `/v1/judgments`), then the muted finders. Capacity (Issues closed, idle allowance, the load ceiling, the test slot wait, the steps by peak memory, the edges) is on Throughput, from `/v1/capacity-loop`. Every other number comes from `/v1/kpis`, `/v1/seats` (By seat, the light seat's delivery, Reviewers) and `/v1/fix-commits`; the page only subtracts. The
words and the arithmetic are `src/lib/improve.ts`, unit-tested in `test/improve.test.ts`; `tests/e2e/improve.e2e.ts` compares
every card with the API at 7 and 30 days.

## Build

```
bun install                              # at the repo root
bun run --cwd apps/console build         # tsc, then vite build into apps/console/dist
bun run --cwd apps/console typecheck
bun test ./apps/console
```

`src/routeTree.gen.ts` is generated by the router plugin and committed (excluded from oxfmt and oxlint). The PWA icons in
`public/icons/` are committed; the sources and the native app icons are in `docs/brand/`.

## The contract with the server

The server's second listener serves `apps/console/dist` as static files and forwards `GET /health` and `GET /v1/*` to the
API with the owner token; an extension-less path falls back to `index.html`. So the app calls same-origin `/v1/...`, with no
auth header and no base URL, and every response is parsed with the schema from `@software-factory/contract`. The service
worker never caches `/v1`: the last snapshot lives in the Query persister (`localStorage`, key `console-snapshot`, 7 days,
invalidated by the build id; artifact and Issue detail queries stay out of it, being large). The listener forwards exactly fourteen writes, the owner's answers, a collection's pin and unpin and an account's mode set and clear (a Decision's answer, an
artifact's verdict, a comment and the edit or deletion of one, an Errand done, an Errand approved, a quarantined signal promoted or dismissed with a reason); the app posts JSON to them same-origin, and
`/checkpoints/<id>` (the link of the owner's pages) redirects to `/needs-you?item=<id>`. `GET /v1/stream` (server-sent events) invalidates the queries a change can alter (`affected` in `src/lib/policy.ts`: a frame's `kind`, `ref` and `detail` name them; a frame that does not parse, or has an unknown kind, alters all but the strip's readings); while it is not open the
queries poll every 15 s and the strip's Live says `Polling`, and while it is open they still poll once a minute, because the
stream's keepalive is an SSE comment `EventSource` cannot see: a watchdog (`src/lib/live.ts`) also replaces the connection
after the machine slept or the tab was hidden a while without a frame. The listener marks every API answer `no-store`,
and the app fetches with `cache: 'no-store'`. A restored snapshot is a first paint only: restoring it refetches everything.

## Staying current

`src/lib/update.ts` owns the service worker registration. The worker takes over by itself (`skipWaiting` and `clientsClaim`
in `vite.config.ts`: with `injectRegister: false` the PWA plugin does not default them, and a new worker then waits for ever
behind the one that controls the open window, which was the hard reloads). A long-lived tab or installed app asks for a new
worker when it becomes visible, when it comes online, on every stream `hello`, every minute and when an answer does not match the
contract (`ShapeError` in `src/lib/api.ts`: the server is newer than the bundle; an answer that only adds a field is no
`ShapeError`: it is read as it is and asks for the new bundle in the background). Once the new worker has taken over the
page does not reload under the owner: it loads the bundle at the next navigation to another screen (`reloadOnNavigation`,
called from the router's `onBeforeLoad` in `main.tsx`), or when the tab hides (`reloadNow` in
`src/lib/policy.ts` holds the rule, and never while a field has focus or a textarea holds a draft); a quiet tab is someone
reading, so no idle timer reloads it. The reload keeps the reading position: `src/lib/scroll-keep.ts` stores the scroll of every
container marked `data-scroll-restoration-id` by address before it and puts each back once the screen's skeletons are gone and
its content reaches the position. The router's `scrollRestoration` keeps the same containers across back and forward. A screen that has no data
because of a `ShapeError` is the exception: it shows its skeleton (`useScreen`, `src/lib/screen.ts`) and reloads the moment the
worker is in; after 20 s without it the screen says "This Console is older than the server. Reload the page to update it".
Any other failure says the status.

The strip says what the window runs and whether it is current: the Live lamp's trigger carries `updating` while a new build is
on its way in and `build 3 h ago` from 1536 px up; its popover lists the build id and age, the update (`Up to date`,
`Updating`, `Not applied`) and the stale reads. A build that has not taken for two minutes (`UPDATE_STUCK_MS`, a draft or
a focused field held the reload) shows a notice under the strip with one button, `Update now`, which forgets the worker and its
caches and loads the page from the network (`updateNow`). A read is stale when its data is older than its poll interval and
15 s (`staleReads`, `src/lib/freshness.ts`; the interval is the observer's `refetchInterval`): the lamp turns warn and counts
them, the popover names them, and a notice under the strip says how old the screen's own data is (the strip's readings are
left to the popover). `tests/e2e/update.e2e.ts` swaps the build under an open page (`tests/e2e/build-swap.ts`) and sees the
new build id without a reload by hand.

## Speed

Every screen renders a skeleton at its final height while its first read loads (`src/components/skeletons.tsx`). A link to
an Issue or an artifact warms the read and the chunk on hover and focus: the two routes have a loader that starts the query
(`prefetchDetail`, `PREFETCH_STALE_MS`, 30 s) without waiting for it, which the router's intent preload runs, and a Needs-you
card does the same for its review's artifact and its Decision. The palette's two lists (550 KB at 500 Issues) are fetched when
the page is idle (`prefetchPalette`) and watched only while the palette is open; Needs you reads the open Issues' cards for
titles. `tests/e2e/speed.e2e.ts` holds the skeleton, the update and the hover guarantees and shoots every skeleton.

The stream does not invalidate everything. Changes that arrive within 250 ms of each other (at most 1 s after the first of a
burst) invalidate, once, the lists and the pages they can alter; the aggregates (on `/improve`: KPIs, friction, finding
classes, fix commits; on the Overview: the trend chart) wait for a 2 s pause (at most 10 s). Accounts and machine are not in the stream and only poll. The
first `hello` of a page joins the boot's requests (`cancelRefetch: false`) instead of cancelling and repeating them. Chunks:
the entry holds the shell and the screens that are small; `@xyflow/react` and dagre (`/chain`), react-markdown
(`/artifacts`) and the command palette (cmdk, loaded when it is first opened) are their own chunks, all precached by the
service worker. A list is virtualised only where it can grow to hundreds (none today); the lists hold a handful of rows.
Keys must not carry a timestamp that moves with each answer, or the row is rebuilt on every refetch.

## Tokens

`src/styles/tokens.css` is generated and committed:

```
bun run --cwd apps/console tokens         # regenerate
bun run --cwd apps/console tokens:check   # fails when the file is stale
```

`src/styles/index.css` bridges the `--vx-*` tokens to the semantic colours, radii and fonts shadcn's classes use
(`@theme inline`). The theme is the `data-theme` attribute, set in `main.tsx` before first render from the OS, or from the
override the palette stores in `localStorage`. The manifest and `<meta name="theme-color">` read their colour from
`tokens.css` at build time.

## Artifacts

`/artifacts/<id>` (`?revision=n&compare=m`) is where the owner reads a Concept, Spec, Report or Decision, marks text and
gives the verdict. A lead hands one over with the CLI:

```
factory artifact submit <issue> --attempt <n> --kind spec --title "..." --content @artifact.md
factory artifact submit <issue> --attempt <n> --kind report --title "..." --content @artifact.html --content-format html
factory artifact revise <artifact> --content @artifact.md --note "what changed"   # after a verdict of Changes
```

`factory artifact submit --help` has the rest. Start from `templates/artifact.md` (TLDR first, then the decision, options,
risks, proof; tables with the minimum separator `|-|-|`) or `templates/artifact.html`: self-contained, Basalt's tokens as
CSS variables with light and dark, semantic classes (`callout`, `table-wrap`, `pre`, `figure`), pictures as inline SVG or
`data:` URLs. Its token block is generated (`bun run --cwd apps/console templates`, `templates:check` in `make check`).
An HTML artifact starts from the template and declares `color-scheme`; the CLI's `artifact submit` and `artifact new` help say so.
A diagram is a figure in an HTML artifact, never ASCII art in a fenced block: `bun apps/console/scripts/diagram.ts <file.mmd> --caption "..." [--width 960]` renders Mermaid to a `<figure>` with Pele (a `devDependency`; its CSS variables are mapped to the tokens by the template's `.pele` rule, so the theme re-colours it), and the frame's wide track gives a figure wider than the column the pane.

**What the frame enforces on an HTML artifact** (`public/frame/frame.js`, `public/frame/lightbox.js`; the template's head lists
the same rules for the author):

- **Theme.** The artifact follows the Console's theme, not the system's. The page sends `theme` (`light` or `dark`, from
  `document.documentElement.dataset.theme`, `lib/theme.ts`) in `factory.render` and `{type:'factory.theme', theme}` when it
  changes; the frame sets `data-theme` and `color-scheme` on the artifact's `<html>` and a `<meta name="color-scheme">`, so a
  toggle re-themes an open frame without a reload. The artifact's own `@media (prefers-color-scheme: …)` rules are rewritten to
  hold for the Console's theme instead of the system's. The template's tokens key dark on `:root[data-theme='dark']` as well as
  the media query. An artifact whose CSS names no scheme (no `color-scheme`, no `prefers-color-scheme`, no `data-theme`) gets a
  Basalt dark base in dark, appended after its CSS: the page and text colours from the dark tokens, links, and the pure light
  greys and whites it paints with (a card, a table header, code, a rule) swapped for the dark surfaces, found by the computed
  style of each element before the base exists. Nothing is inverted, an `img` is never recoloured, and an inline SVG that draws
  on the page stays a light plate. One that declares a scheme is left to its own CSS.
- **One text column.** Paragraphs, lists, definition lists, quotes and every heading share one centred 76-character column with
  one left edge, wherever they sit (header, aside, nested wrappers, a wrapper with its own `max-width`, which is centred in the
  pane). The measure is registered as a length on `body`, so a heading's larger font does not widen it.
- **Wide media.** An `img`, `video`, `canvas`, an `svg` outside a figure, a `figure` or a `data-wide` table that is wider than the
  column and fills it leaves it: it is as wide as it is, up to the pane less the page padding, centred on the pane, never
  upscaled. A smaller one, a picture that a table cell, a row or a list holds, and one the artifact sized itself stay put;
  `data-measure` keeps one in the column.
- **Lightbox.** A click (or Enter) on a picture (an image of 200 px or more, an svg of 160 px or more, a figure that holds one;
  not one in a link) opens it in a fullscreen `<dialog>` inside the frame: Esc, the close button or a click beside it closes,
  arrows and buttons step through every picture of the document with an "n / N" counter and the figcaption, a second click
  shows the natural size and a drag pans. It opens only with no text selected and the pointer where it went down, so the
  comment flow is untouched, and the dialog lives outside `<body>`, which the annotator indexes. No network, no dependency.

Markdown is rendered with react-markdown: raw HTML is dropped and `javascript:`/`data:` links are refused. An image loads
only over `https` from a host the owner lists in `FACTORY_CONSOLE_IMAGE_HOSTS` (comma-separated `host` or `*.domain`, in
`~/.config/factory/env`, none by default, a restart applies it): the page's CSP is `img-src 'self' data:` plus those
hosts. Any other image, or one that fails (an expired presigned link), shows a dashed "picture not shown" block with the alt text and the reason; `factory artifact submit` and `revise` refuse such a picture up front (an HTML artifact's `<img>` must be a `data:` URL). A lead links shots from a listed
host (for a private bucket a presigned URL, `imgcli private <file> --json`; `raw.githubusercontent.com` is not listed) or inlines
them in an HTML artifact. A blocked image's alt text names the host in its tooltip, and `factory artifact submit --help` says so to the lead. HTML runs in
`<iframe sandbox="allow-scripts" src="/frame.html">`, a separate document: the listener serves `/frame.html` and `/frame/*`
(`public/`) under their own CSP (`default-src 'none'`, no `connect-src`, `frame-src`, `form-action` or `base-uri`; images
and fonts from `data:`; `sandbox allow-scripts`), so the artifact's inline script runs while nothing leaves the frame, and
the page keeps `script-src 'self'` (a `srcdoc` frame would inherit it). The page posts `{type:'factory.render', html}` once
the frame has loaded; `frame/frame.js` writes it into the document and adds `frame/annotator.js`, which posts
`factory.ready` and `factory.select` back and paints `factory.highlight` with the CSS Custom Highlight API. Each side
believes only its parent or its own frame's window, in the exact shape (zod on the page). A quote is the selected text with
whitespace folded to single spaces: the API anchors it on the artifact's readable text. A comment also records which
occurrence it is (its 0-based number among the quote's matches in that text) and about 32 characters before and after it;
the page and the frame paint, scroll to and open a passage by the same resolver (`resolveQuote` in `lib/artifact.ts`,
mirrored between `anchor:begin` and `anchor:end` in `frame/annotator.js`, both run by `test/anchor.test.ts`): the occurrence
with the same text around it, then the number, then the first one under the stored heading path, then the first one, which is
all a comment made without them gets.

**Comments on pictures.** A picture is commented like a passage, with an `image` anchor in place of the quote: its place among the
document's pictures (the lightbox's list), the hash of its `src` as written (`srcHash` in `packages/contract/src/image-anchor.ts`,
FNV-1a, eight hex digits), its caption or alt text, and optionally a spot on it (`x`, `y`, 0..1). The API derives the quote
from it (`Image 2: Queue screen · spot 42% / 63%`), so the lead reads and answers it as any comment. A later revision finds the
picture by the same hash, else the same label, else (only for a picture that had neither) its place (`resolveImage`, mirrored
between `image:begin` and `image:end` in `frame/lightbox.js`, both run by `test/image-anchor.test.ts`); a replaced picture goes
"Unanchored" rather than moving its comment onto another one. The server sorts Anchored from Unanchored by reading the
pictures from the source text (`imageRefs`), which cannot see sizes or links, so it is approximate; the frame and the page place
the marker exactly. In an HTML artifact the lightbox script, once the page has sent `factory.images`, shows a comment button on a
hovered or focused picture (`C` on a focused one), a count badge on a commented one, and in the viewer a "Comment" and a "Mark a
spot" button (the next click drops a pin), numbered pins and the picture's comments in a side list; it posts
`factory.image` (open the comment box here) and `factory.image-open` (a badge or pin was clicked) and takes
`factory.image-focus` (a card was clicked: scroll to the picture, or open the viewer with its pin when it marks a spot). All of it
is built outside `<body>`, so the annotator's text index is untouched. A Markdown image has the same button and badge
(whole-picture comments only: Markdown has no viewer, so no spot); a card in the Comments pane shows the picture's thumbnail
where the page can load it (`pictureSources`).

**Reviewing** (`lib/review.ts`, `components/artifact-comments.tsx`, `artifact-toc.tsx`). A comment, an edit and a delete show
at once and are sent in the background: each write is kept in local state, marked "Sending", until the server has answered and
the artifact has been read back; a failed one stays on its card with the error, Retry and Discard (Undo, Keep), the text never
lost. A click on a highlighted passage (Markdown directly; the frame posts `factory.open` with the quote) opens its card in
edit mode when the comment is the owner's and scrolls the card into view; a click on a card scrolls the document to its passage.
The sidebar lists the comments of the revision shown; the rest fold under "Previous revision (N)" (or "Later revision"), each
marked "carried" (its quote is still in the text, still highlighted) or "resolved by revision". A card leaves the document's own
name off its heading path. Links: `#anchor` scrolls inside the document, an `http(s)` link opens a new tab (the frame posts
`factory.link`; the page opens it with `noopener`), a link to an Issue or an artifact opens that page, anything else is plain
text with its target in the tooltip. The table of contents is the document's headings (the frame posts `factory.headings`
and `factory.section`, and takes `factory.goto`): from 1800 px the right column is 36 rem, a third contents and two thirds
comments, the section in view marked as the document scrolls (the last headings at the end of the document count as in view);
narrower, a collapsible "Contents" bar under the header. The owner gives one of three verdicts: Looks good (with an optional note; the lead applies the note and every open comment),
Changes (needs a note) and No longer applies. Each verdict button carries its consequence (`VERDICT_CONSEQUENCES`) in a tooltip and as its
accessible description (`VerdictButton`); nothing is printed under the buttons. The API and the CLI still accept `with_notes`
and store it as `looks_good`.

## The Issue page

`/issues/<n>` (the Issue's number; the API takes `12` or `issue_12`) reads `GET /v1/issues/:id` and `GET /v1/chain`, nothing
else. A header (kind, state, project chip, title, summary, the owner's next moves as links, the facts), then from `lg` up
two columns: tabs on the left and an aside on the right (Properties; the Chain around this Issue, Waits on and Blocks); below
`lg` the aside stacks under the tabs. The tab is the URL's `?tab=activity|evidence|checkpoints` (the overview is the bare
address; history is replaced, not pushed). Overview: what it is, a StatCard row (active time, turns, tokens out, cache read
share; bars per attempt from two attempts), the attempts, and how it was filed and amended (`triage`). Activity: the event
log in words as a StepRail per attempt. Evidence: each ship with its commits, review, acceptance, watch and verify runs, then
the evidence. Checkpoints: Decisions with their options, artifacts, the notes you sent; the tab shows how many wait on you.
The pure model (tabs, groups, series, chain links, tones) is `src/lib/issue-page.ts`. Every figure is the API's, only
phrased; no id is on screen. A Needs you card and an Overview row link to it. It is read-only on purpose: the listener forwards
fourteen verbs (ten answers, pin and unpin, an account's mode) and none of them is a note or a cancel, and the Console never cancels an Issue or starts a session. An open
Decision links to `/needs-you?item=<id>`, an artifact to `/artifacts/<id>`, where the answer is given.
`tests/e2e/issue.e2e.ts` compares the page's numbers with the API's.

## Kit

`src/components/kit/` holds the Console's own components (StatCard, Lozenge, KindBadge, IssueCard and IssueRow,
PropertyList, Section and Fold, StepRail, Meter and MeterBar, Sparkline, MiniBars, StackedBars and TimeChart (`kit/time-chart.tsx`, a time axis with a reference line), InfoHint, EmptyState, Skeleton), each on Basalt
tokens alone, and `/kit` shows them together on fixtures (reachable by its address; it has no nav entry and makes no query).
An InfoHint's text is the word's definition from `docs/language.md`: `scripts/language.ts` writes
`src/lib/language.gen.ts` (`bun run --cwd apps/console language`) and `language:check` in `make check` fails when it is
stale. tuffui's `stat-grid`, `agent-question` and `tool-approval-queue` were evaluated first: they are MIT, but they pull
`motion`, a `theme.json` and their own surface, status-pill and rolling-number primitives, and do not use Base UI, so
their anatomy was rebuilt on Basalt tokens instead of taking one.

## Colours are enforced

`test/no-raw-colour.test.ts` fails on any colour literal in `src`, `index.html` and `vite.config.ts` except the generated
`tokens.css` and `routeTree.gen.ts` and `series.css` (the chart palette, validated with the dataviz skill's script): hex, colour functions, `color-mix` with a literal argument, named colours used as
values, and Tailwind palette utilities (`bg-red-500`, `border-white`, `bg-[#123]`). The rule is `test/raw-colour.ts`, with
its own passing and failing samples in `test/raw-colour.test.ts`. Use a semantic class (`bg-card`, `text-muted-foreground`)
or add a token to the bridge.
