# Console BEFORE baseline (1800x1200, mini, headless Chrome via Playwright CDP; Chrome DevTools MCP was not available)

Method: fresh browser context per route (cold cache, no snapshot), `load` + 4 s settle. "1x" = mini unthrottled, "4x" = CPU throttle 4x (a laptop-like proxy). Raw traces: /tmp/console-perf/before/trace-*.json (+ -cpu4x), screenshots shot-*.png, data load*.json ix*.json storm*.json, scripts in /tmp/console-perf/scripts/.
Entry chunk index-D872EJPo.js: 859 KB raw, 245 KB transferred (brotli/gzip). Total JS transferred: 241 KB on most routes, 295 KB /chain (+55 KB graph chunk, @xyflow), 289 KB /artifacts (+49 KB chunk).
Interaction numbers are time from the input event to the 2nd animation frame (floor = ~16 ms; a 33 ms in-page click read is 2 frames).

| route | LCP ms 1x/4x | JS KB | long tasks 1x (n/max ms) | long tasks 4x (n/max) | TBT 4x ms | DOM nodes | Ctrl/Cmd+K palette med/max ms | route action med/max ms (1x) | requests (of which /v1) |
|-|-|-|-|-|-|-|-|-|-|
| /needs-you | 220 / 492 | 241 | 0/0 | 2/197 | 0 | 103 | 16.7/22 | expand card 34/48 | 15 (9) |
| /flow | 160 / 444 | 241 | 0/0 | 2/149 | 0 | 310 | 11.5/25.8 | not measured (project filter, see below) | 15 (9) |
| /chain | 372 / 580 | 295 | 0/0 | 2/140 | 0 | 314 | 13.2/23.4 | not measured | 19 (11) |
| /improve | 304 / 520 | 241 | 0/0 | 2/148 | 0 | 559 | 10.9/17.3 | open details 32/43 | 23 (17) |
| /issues/528 | 164 / 476 | 241 | 0/0 | 2/152 | 0 | 197 | 14.4/18.3 | toggle section 31/38 | 17 (11) |
| /issues/523 | 152 / 452 | 241 | 0/0 | 2/149 | 0 | 218 | 13.6/23.9 | toggle section 33/39 | 17 (11) |
| /artifacts/<id> (report) | 148 / 500 | 289 | 0/0 | 3/142 | 18 | 263 | 16.2/23.9 | not measured | 19 (11) |
| /artifacts/<id> (spec) | 152 / 440 | 289 | 0/0 | 2/147 | 0 | 116 | same | not measured | 19 (11) |
| /checkpoints/<id> | 196 / 540 | 241 | 0/0 | 2/140 | 0 | 131 | n/a | redirects to /needs-you?item=<id> | 18 (9) |

Scroll (30 steps, 2-frame read): /improve 4142 px scrollH, med 33.4 / max 38.8 ms; /issues 1226-1414 px, 33 / 39 ms; /artifacts 3358 px, 33.6 / 37 ms. /needs-you, /flow, /chain do not scroll with today's data. At 4x: palette med 17-25 ms, needs card expand 55 med / 136 max, others 25-29.
The 2 long tasks at 4x (~140-197 ms) are boot (bundle evaluate + first render); TBT counts only tasks after FCP so it reads 0. Longest unthrottled RunTask in the traces: 34-38 ms.
LCP element: /needs-you the 2-line summary of a card; /improve a table header.

## Render storm on invalidation
The live stream carried NO change events in the 60 s I watched (only `hello`), so the factory was quiet; nothing real to storm. Over a real 10 s window: 0 mutations, 0 long tasks, 0 /v1 requests on /needs-you and /flow; over 60 s: 4 (needs-you) / 21 (flow) mutations, from the 15 s accounts+machine poll (2 requests every 15 s, runs even while live).
So I injected `issue` events into the page's own EventSource (same handler path, debounce 250 ms), 10 s window, mini 1x / 4x CPU:
- One invalidation = 4 requests on /needs-you, /flow (needs, flow, accounts, machine), 5 on /issues/<n> (+issue), 8 on /improve (+kpis, friction, finding-classes, fix-commits). Even /artifacts, /chain add their own on top of the 4. Boot costs the same again: `hello` fires an invalidate, so every cold load fetches needs/flow/accounts/machine twice (9 requests, not 5).
- 1 event/s: needs-you 40 req, 3 mutations, main-thread task time 46 ms (1x) / 162 ms (4x); flow 40 req, 1 mutation, 52 / 169 ms; improve 80 req, 96 mutations (~8-10/s), 100 / 343 ms; issue 50 req, 2 mutations.
- 4 events/s: needs-you 44 req (1x) / 160 (4x); flow 76 / 156; improve 184 / 280 req, 210 / 282 mutations (18-24/s), task time 194 / 1086 ms in 11.6 s (9% busy at 4x); issue 65 / 195 req. No long tasks (>50 ms) in any window; layout <=32 ms total.
- The trailing debounce restarts on every event: events arriving faster than 250 ms apart would delay the invalidate indefinitely (not exercised).

## Lists
- /needs-you: cards in 3 sections via items.map, NOT virtualised; 2 items now (103 DOM nodes), grows linearly with the queue, no React.memo anywhere in apps/console/src (grep), so a changed `needs` payload (it carries `at`) re-renders every card.
- /flow: 5 columns, FlowList uses @tanstack/react-virtual (the only use in apps/console/src, components/flow/list.tsx); 6 open cards now; closed-recently (133) is not a column. Virtualised.
- /chain: @xyflow/react graph, 16 nodes / 15 edges, all rendered (no onlyRenderVisibleElements, grep).
- /improve: 4 tables via .map, 559 DOM nodes, KPI rows + friction classes + fix matrix; not virtualised; this page is the largest and re-renders ~10 mutations per invalidation.
- /issues/<n>: timeline/sessions/notes/evidence via .map, not virtualised; 6 timeline lines for #528; a long-running Issue grows unbounded.
- /artifacts/<id>: one rendered markdown body (6.9 KB JSON here, but specs can be megabytes per the comment in main.tsx), not virtualised.

## Top 5 causes of slow interaction (ranked; at the current tiny data set none of them crosses 50 ms unthrottled, so rank = headroom lost on a slower device or bigger data)
1. Every stream change refetches everything active: 4-8 requests per invalidation (`invalidateQueries()` with no filter), plus the strip's accounts/machine, which are not stream-driven. At 4 events/s that is 160-280 requests in 12 s and 313-603 ms script time at 4x. Evidence: storm-injected*.json byUrl.
2. Boot double-fetch + 859 KB entry chunk: `hello` invalidates right after prefetch, so needs/flow/accounts/machine are requested twice on every cold load; entry chunk evaluates in a 140-197 ms long task at 4x (the only long tasks measured). Evidence: v1 request list in load.json, longtasks 4x.
3. Whole-page re-render per response: /improve produces ~96 DOM mutations per 10 invalidations (and 15 layouts) while the payload is semantically unchanged; /flow `at` changes every response. Evidence: storm improve@1Hz mutations 96, layoutCount 15, vs 1-3 on the other routes.
4. Unvirtualised lists scale with data: /needs-you cards, /issues timeline, /improve tables, artifact body; expanding a /needs-you card is 34 ms med at 1x but 55 med / 136 max at 4x with only 2 cards (BodyOf mounts decision/review bodies, scrollIntoView + focus in the same commit).
5. 15 s accounts+machine poll regardless of stream state: constant background requests and re-renders of the StatusStrip on every route (4 mutations/min on needs-you, 21 on flow). Minor.

## Not measured
- Chrome DevTools MCP tools were not available in this session; used Playwright over CDP with the installed Chrome instead (same CDP traces, no DevTools insight panel / INP summary). INP was taken as input-to-2nd-frame, not the DevTools INP.
- Real storm: the stream was silent in my window; the storm is injected, not organic. An owner's laptop and a real busy day (many open Issues/Needs) are not reproduced; data is 2 Needs, 6 open Issues.
- Flow filter, chain and artifact-specific interactions (text selection, verdict) not timed; flow/chain/needs do not scroll at this data size.
- /checkpoints/<id>: a real checkpoint id was taken from /v1/needs (a Spec review artifact); it redirects to /needs-you?item=<id>.
