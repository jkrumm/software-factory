# Console

The owner's place for decisions, on a phone and a desktop: a Vite + React SPA (Base UI through shadcn, Tailwind 4, Basalt
tokens, TanStack Router, Query and Hotkeys), installable as a PWA. It holds no logic the API could hold. This is the shell:
a sidebar, a one-line header strip, the command palette, and the screens (Needs you, Flow, the Issue page, the Chain, Improve).

**Sidebar** (`components/sidebar.tsx`, from `md` up; a tab bar below): the logo slot and wordmark, the four screens with their
keys (`g n`, `g f`, `g c`, `g i`) and counts, then the page's own section. A page fills that section with
`<SidebarSection title>` (a portal into the sidebar's slot, gone when the page unmounts): Flow's projects and origins,
Needs you's kinds (`?kind=`), Chain's projects, Improve's window. Each is a toggle on a search param, and the page's own
select or switch stays below `md`. Collapsed to icons (14 rem or 3.5 rem, kept in `localStorage` as `console-sidebar`) the
section is hidden, so a page shows its active filters as removable chips (`ActiveFilters`) and Improve keeps its window switch.

**Header strip** (`components/status-strip.tsx`, `components/strip/`): working, waiting and queued from `/v1/flow`, each a
link to `/flow?state=...`; one meter per subscription from `/v1/accounts`; the host's load, memory and swap with the last
24 h and the busiest processes from `GET /v1/host`; and Live. Each meter and Live opens a popover. Live says `Live`,
`Polling` while the event stream is closed, or `Offline` with the snapshot's age.

**Palette** (`Mod+K`): Issues by title or number across projects, projects, artifacts and commands (theme, the screens with
their keys).

## Flow

`/flow` fills the content area (no width cap). From the top: the header, a stat row, then the board of every Issue by state:
Settling, Queued, Working, Waiting, Watching and Closed recently (the last 24 hours), from `GET /v1/flow`, refreshed by the
stream like every other screen.

**Stat row.** Four kit `StatCard`s: Working, Waiting, Queued (a line of the Issues in that state at eight daily samples,
`trend` in the model) and Shipped this week (bars of the done and healed closes per day, against the 7 days before). They
are factory-wide, never narrowed by the filters; each opens `/flow?state=<state>` (Shipped: `closed`), the same view the
header strip's counts open. Below `lg` the row scrolls sideways inside itself, snapping per card.

**Cards.** A card is the kit `IssueCard`, the whole card a link to `/issues/<n>`: the title, a `KindBadge`, the project, the
origin as a muted word, the reason (a wait's reason or the queue's message) and the age in mono; never an id. A column
already names the state, so only Closed recently shows a Lozenge, the outcome (Done, Dropped, Healed, Cancelled).

**Columns.** The header is the label and count as the `h2` ("Working 3"), an `InfoHint` for the state beside it (Closed
recently: outcome) and a hairline under. From the `lg` breakpoint (1024px) the six columns share the width equally in a
board that scrolls sideways inside itself when they do not fit (1280px), and the board fills the height under the stat
row; every column is its own virtualised list (`@tanstack/react-virtual`): only the visible cards are in the DOM. Below
`lg` the board is one list with a tab per state (Working first, or the first state with cards). The layout switches with
`matchMedia`, so only one of the two is ever rendered.

**Filters.** Projects and origins are toggles in the sidebar (selects on a phone only) and live in the URL
(`/flow?project=argo&origin=feedback`), so a filtered view is linkable, and each column header counts what the filters
leave. `?state=working|waiting|queued|settling|watching|closed` shows only that column, full width as a grid of cards,
with a "Show all states" link (it never filters rows); on a phone it picks the tab.

## Chain

`/chain` draws the dependencies between Issues and plan rows across projects from `GET /v1/chain`: `@xyflow/react` for the
canvas, `@dagrejs/dagre` for the layout (`src/lib/chain-layout.ts`, left to right, a blocker left of the node that waits for it),
loaded as its own chunk so the other screens do not carry them. The page is `<Page full>`: a compact header, then the graph
fills the rest of the height and the full width on a canvas step (at least 28 rem high, 24 rem on a phone), and the schedule
sits under it; the graph fits again whenever the canvas resizes (centred, never above 110 %; on a phone it starts at 90 % at the top left, so the graph is panned, with the zoom controls at the top right). An arrow runs from the blocker into the node that runs after
it. A blocked edge is solid warn and thick, labelled `blocks`; a satisfied one (the blocker has closed) is dashed and quiet,
labelled `done`, and the two arrive on separate handles of the node; each edge also has an accessible text ("A blocks B"), and a legend in the corner (from `md` up) names both and the dashed
plan row. A node is the kit `IssueCard` at a fixed 320 x 128 (`NODE_WIDTH`, `NODE_HEIGHT`, which dagre reads): an Issue is a
link to `/issues/<n>` with its kind, state, one reason line (its wait reason, "Waits for <blocker>" while a blocker is open, else what its state means, "Closed, no longer blocks" for a closed one) and age; a plan row is the same card on a dashed outline, not a link,
with "Not filed yet" in the chip row, no age, a Lozenge for its state (`waiting`, or "Ready to file") and, when it waits for a
date, "Not before Mon 16 Nov, 09:00" (the viewer's zone, the UTC instant on hover). No id is on the page. Nodes with no edge
and no date are not drawn: the header counts them ("N items have no dependencies"). `?project=argo` keeps that project's nodes
and every node an edge joins them to, so an edge across projects stays readable. With no edge the graph part says "No
dependencies". xyflow's variables are pointed at the semantic tokens in `src/styles/index.css`.

**Schedule** (`components/chain/schedule.tsx`, the logic in `scheduleOf` in `src/lib/chain.ts`): every plan row with a
`notBefore` under the project filter, with or without an edge, as a marker on a time axis from now to the last date inside 120
days (at least 7 days), day ticks up to 14 days and Monday ticks after, in mono, a "Now" mark at the left. Each row has a chip
(title, project, date, "in 6 days"); a chip that would cover a later date's dot sits above that chip, so every dot's stem reaches its own chip; tick labels thin out to every nth when they would touch; a row whose date has passed and is still not filed
is pinned at Now as "due"; a row past the horizon is in the "Later" cell at the right end with its date. The picture is
`aria-hidden`; a visually hidden table lists the same rows for a screen reader. On a phone the band scrolls inside itself.
`tests/e2e/chain.e2e.ts` compares the page with the API on a seeded chain across two projects (`seed-chain.ts`, whose plan dates
are computed from the seed time).

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
invalidated by the build id; artifact and Issue detail queries stay out of it, being large). The listener forwards exactly six writes, the owner's answers (a Decision's answer, an
artifact's verdict and comment, an Errand done, a held signal promoted or dismissed with a reason); the app posts JSON to them same-origin, and
`/checkpoints/<id>` (the link of the owner's pages) redirects to `/needs-you?item=<id>`. `GET /v1/stream` (server-sent events) invalidates the queries a change can alter (`affected` in `src/lib/policy.ts`: a frame's `kind`, `ref` and `detail` name them; a frame that does not parse, or has an unknown kind, alters all but the strip's readings); while it is not open the
queries poll every 15 s and the strip's Live says `Polling`, and while it is open they still poll once a minute, because the
stream's keepalive is an SSE comment `EventSource` cannot see: a watchdog (`src/lib/live.ts`) also replaces the connection
after the machine slept or the tab was hidden a while without a frame. The listener marks every API answer `no-store`,
and the app fetches with `cache: 'no-store'`. A restored snapshot is a first paint only: restoring it refetches everything.

## Staying current

`src/lib/update.ts` owns the service worker registration. A long-lived tab or installed app asks for a new worker when it
becomes visible, when it comes online, on every stream `hello`, every 10 minutes and when an answer does not match the
contract (`ShapeError` in `src/lib/api.ts`: the server is newer than the bundle). Once the new worker has taken over, the
page reloads, but only when nothing is being typed (no focused field, no draft in a textarea); otherwise it waits for the
tab to hide or the field to lose focus. A screen with no data says what happened: "This Console is older than the server -
updating" for a `ShapeError`, the status for any other answer.

## Speed

The stream does not invalidate everything. Changes that arrive within 250 ms of each other (at most 1 s after the first of a
burst) invalidate, once, the lists and the pages they can alter; the aggregates on `/improve` (KPIs, friction, finding
classes, fix commits) wait for a 2 s pause (at most 10 s). Accounts and machine are not in the stream and only poll. The
first `hello` of a page joins the boot's requests (`cancelRefetch: false`) instead of cancelling and repeating them. Chunks:
the entry holds the shell and the screens that are small; `@xyflow/react` and dagre (`/chain`), react-markdown
(`/artifacts`) and the command palette (cmdk, loaded when it is first opened) are their own chunks, all precached by the
service worker. A list is virtualised only where it can grow to hundreds (the Flow columns); the others hold a handful of rows.
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

Markdown is rendered with react-markdown: raw HTML is dropped, `javascript:`/`data:` links are refused and an image shows
its alt text instead of loading (the CSP is `img-src 'self' data:`). HTML runs in
`<iframe sandbox="allow-scripts" src="/frame.html">`, a separate document: the listener serves `/frame.html` and `/frame/*`
(`public/`) under their own CSP (`default-src 'none'`, no `connect-src`, `frame-src`, `form-action` or `base-uri`; images
and fonts from `data:`; `sandbox allow-scripts`), so the artifact's inline script runs while nothing leaves the frame, and
the page keeps `script-src 'self'` (a `srcdoc` frame would inherit it). The page posts `{type:'factory.render', html}` once
the frame has loaded; `frame/frame.js` writes it into the document and adds `frame/annotator.js`, which posts
`factory.ready` and `factory.select` back and paints `factory.highlight` with the CSS Custom Highlight API. Each side
believes only its parent or its own frame's window, in the exact shape (zod on the page). A quote is the selected text with
whitespace folded to single spaces: the API anchors it on the artifact's readable text.

## The Issue page

`/issues/<n>` (the Issue's number; the API takes `12` or `issue_12`) reads `GET /v1/issues/:id` and nothing else: the title and
state, the facts (account, weekly quota, insights), how the Issue was filed and amended (`triage`), each attempt and its
state, the owner's notes, the Decisions and artifacts with links to their own pages, shipping with its watch and checks,
and the history, oldest first. Every figure is the API's, only phrased; no id is on screen. A Needs you card links to it
(Open Issue). It is read-only on purpose: the listener forwards six answer verbs and none of them is a note or a cancel,
and the Console never cancels an Issue or starts a session. An open Decision links to `/needs-you?item=<id>`, an artifact
to `/artifacts/<id>`, where the answer is given. `tests/e2e/issue.e2e.ts` compares the page's numbers with the API's.

## Kit

`src/components/kit/` holds the Console's own components (StatCard, Lozenge, KindBadge, IssueCard and IssueRow,
PropertyList, Section and Fold, StepRail, Meter and MeterBar, Sparkline, MiniBars and TimeChart (`kit/time-chart.tsx`, a time axis with a reference line), InfoHint, EmptyState, Skeleton), each on Basalt
tokens alone, and `/kit` shows them together on fixtures (reachable by its address; it has no nav entry and makes no query).
An InfoHint's text is the word's definition from `docs/language.md`: `scripts/language.ts` writes
`src/lib/language.gen.ts` (`bun run --cwd apps/console language`) and `language:check` in `make check` fails when it is
stale. tuffui's `stat-grid`, `agent-question` and `tool-approval-queue` were evaluated first: they are MIT, but they pull
`motion`, a `theme.json` and their own surface, status-pill and rolling-number primitives, and do not use Base UI, so
their anatomy was rebuilt on Basalt tokens instead of taking one.

## Colours are enforced

`test/no-raw-colour.test.ts` fails on any colour literal in `src`, `index.html` and `vite.config.ts` except the generated
`tokens.css` and `routeTree.gen.ts`: hex, colour functions, `color-mix` with a literal argument, named colours used as
values, and Tailwind palette utilities (`bg-red-500`, `border-white`, `bg-[#123]`). The rule is `test/raw-colour.ts`, with
its own passing and failing samples in `test/raw-colour.test.ts`. Use a semantic class (`bg-card`, `text-muted-foreground`)
or add a token to the bridge.
