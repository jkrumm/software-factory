# Console AFTER (1800x1200, mini, headless Chrome via Playwright CDP; same scripts as before, BASE/OUT via env)

Build of the worktree served by /tmp/console-perf/scripts/serve-dist.ts (consoleHandler over apps/console/dist, forward = GET to the live API on 7795, killed afterwards). Method as in ../before/report.md: fresh context per route, `load` + 4 s settle; 4x = CPU throttle.
Entry chunk index-uXEPjPyT.js: 675 KB raw, 194 KB transferred (before 859 / 245). Split off: palette (cmdk + dialog, 87 KB raw, on first Cmd+K), dagre (now only in the graph chunk). Graph chunk 230 KB raw (+dagre).

| route | LCP ms 1x/4x | JS KB | long tasks 1x (n/max ms) | long tasks 4x (n/max) | TBT 4x ms | DOM nodes | Ctrl/Cmd+K palette med/max ms (1x) | route action med/max ms (1x) | requests (of which /v1) |
|-|-|-|-|-|-|-|-|-|-|
| /needs-you | 120 / 340 | 210 | 0/0 | 2/120 | 0 | 106 | 9.6/21.5 | 31.6/47.7 | 14 (5) |
| /flow | 124 / 408 | 210 | 0/0 | 2/127 | 0 | 304 | 7.6/19.6 | n/a | 14 (5) |
| /chain | 452 / 816 | 279 | 0/0 | 2/144 | 0 | 317 | 9.7/16.5 | n/a | 17 (6) |
| /improve | 204 / 588 | 210 | 0/0 | 2/155 | 0 | 562 | 12.4/23 | 31.4/39 | 18 (9) |
| /issues/528 | 156 / 532 | 210 | 0/0 | 2/149 | 0 | 200 | 15.5/18.7 | 31.7/42 | 15 (6) |
| /issues/523 | 156 / 516 | 210 | 0/0 | 2/160 | 0 | 221 | 9.3/16.3 | 31.7/43.2 | 15 (6) |
| /artifacts/<id> (report) | 148 / 620 | 259 | 0/0 | 3/155 | 33 | 267 | 10.2/20.6 | n/a | 17 (6) |
| /artifacts/<id> (spec) | 148 / 504 | 259 | 0/0 | 2/145 | 0 | 120 | n/a | not measured | 17 (6) |
| /checkpoints/<id> | 168 / 576 | 210 | 0/0 | 2/132 | 0 | 134 | n/a | not measured | 16 (6) |

## Before / after

| measure | before | after |
|-|-|-|
| entry chunk raw / transferred | 859 KB / 245 KB | 675 KB / 194 KB |
| JS transferred on /needs-you | 241 KB | 210 KB |
| JS transferred on /chain (with graph chunk) | 295 KB | 279 KB |
| cold-load /v1 requests: /needs-you, /flow | 9 | 5 |
| cold-load /v1 requests: /improve | 17 | 9 |
| cold-load /v1 requests: /issues/<n>, /chain, /artifacts | 11 | 6 |
| LCP 1x / 4x /needs-you | 220 / 492 | 120 / 340 |
| LCP 1x / 4x /flow | 160 / 444 | 124 / 408 |
| LCP 1x / 4x /improve | 304 / 520 | 204 / 588 (worse at 4x) |
| LCP 1x / 4x /issues/528 | 164 / 476 | 156 / 532 (worse at 4x) |
| LCP 1x / 4x /chain | 372 / 580 | 452 / 816 (worse: dagre moved into the lazy graph chunk, so the graph paints after a second chunk) |
| 4x long tasks (boot), n / max ms | 2 / 140-197 | 2 / 120-160 (n unchanged; /needs-you 197 -> 120, /issues 152 -> 149-160, /improve 148 -> 155: within run noise, boot still evaluates the 675 KB entry) |
| Cmd+K palette med ms (1x), /needs-you | 16.7 | 9.6 (first open of a page loads the chunk; max 21.5) |
| expand card /needs-you med/max ms (1x) | 34 / 48 | 31.6 / 47.7 |
| requests per injected event (1 Hz, 10 events, 1x): /needs-you, /flow | 4.0 | 2.3 / 2.0 (needs + flow; accounts/machine only from their 15 s poll) |
| requests per injected event (4 Hz, 40 events, 1x): /needs-you | 1.1 | 1.2 |
| requests per injected event (4 Hz, 4x CPU): /needs-you, /flow | 4.0, 3.9 | 1.95, 2.0 |
| requests per injected event: /improve 1 Hz | 8.0 | 2.4 (aggregates: 1 request each in 10 s) |
| requests per injected event: /improve 4 Hz 1x / 4x | 4.6 / 7.0 | 1.0 / 2.0 |
| requests per injected event: /issues/528 1 Hz | 5.0 | 3.0 (needs, flow, issue) |
| requests per injected event: /issues/528 4 Hz 1x / 4x | 1.62 / 4.88 | 1.85 / 3.0 (1x worse: the old trailing debounce starved at exactly 250 ms spacing and skipped refetches; now needs, flow and issue each refetch about once a second) |
| DOM mutations in 10 s: /improve 1 Hz 1x / 4x | 96 / 87 | 0 / 4 |
| DOM mutations in 10 s: /improve 4 Hz 1x / 4x | 210 / 282 | 1 / 0 |
| DOM mutations: /needs-you, /flow | 1-3 | 0-1 |
| DOM mutations: /issues/528 (the open Issue's own events) | 2-8 | 0-8 (elapsedMs of a working session changes in the API; real change) |
| main-thread task ms, /improve 4 Hz 1x / 4x | 194 / 1086 | 64 / 421 |
| long tasks in any storm window | 0 | 0 |

The storm injects `issue` frames with a full change body (ref issue_999, or issue_528 on the Issue route) into the page's EventSource; before this change the body was ignored. In the 4 Hz window of /needs-you at 1x the count is dominated by the 15 s accounts/machine poll plus one refetch per second; at 4x CPU it halves.

## Causes found

- Stream: unfiltered invalidateQueries, and a trailing debounce that restarts per event (now debounce + max wait).
- Boot: the first hello cancelled the in-flight prefetches (cancelRefetch default true); the Query snapshot restore did too.
- /improve mutations: the table header `key={week.to}` used a timestamp that moves with every answer, so the header cells were remounted on each refetch (about 10 mutations per invalidation). /chain: `at` in the answer rebuilt the xyflow graph on each refetch (now `select` drops it; 0 mutations).
- Not a cause: the page components (the React Compiler already skips unchanged subtrees; structural sharing works).

## Lists (real sizes seen)

/v1/needs 2 items; /v1/flow 6 open cards (Flow columns already virtualised); the largest Issue detail among #480-#530 has 30 list rows in total across sections (no section above 30); /improve: 11 KPI rows, 40 friction counts (spread over groups), 11 finding classes, 9 fix classes x 4 weeks. Nothing is near 100 rows, so nothing new is virtualised.

## Not measured
- No organic storm (stream silent); frames are injected as before. Real hundreds-of-rows data does not exist here.
- Palette first open pays one chunk load (precached by the service worker); the 10-run median hides it, max 21.5 ms.

## Re-measure after the wire-format fix (supersedes the storm numbers above)

The first storm sent frames whose `data` carried a `cursor`, which the real server never sends (the cursor is the `id:` line), so `changeOf` parsed them and hid a bug: with real frames every parse failed and everything was invalidated. `parseChange` (now in `lib/policy.ts`) parses `ReadChange.omit({ cursor: true })`, and is tested against the `data:` line of the server's own `encodeFrame`. The storm now dispatches `MessageEvent(kind, { data: JSON.stringify({kind,issue,ref,subject,detail,at}), lastEventId })`, no cursor in `data`. `useDecision` and `useErrands` also poll once a minute while the stream is live. Raw: /tmp/console-perf/after2/.

Requests per injected event (10 s windows, 10 events at 1 Hz, 40 at 4 Hz), before -> after:

| route | event | 1 Hz 1x | 4 Hz 1x | 4 Hz 4x CPU |
|-|-|-|-|-|
| /needs-you | issue (other Issue) | 4.0 -> 2.0 | 1.1 -> 0.95 | 4.0 -> 1.85 |
| /flow | issue | 4.0 -> 2.0 | 1.9 -> 1.1 | 3.9 -> 1.95 |
| /issues/528 | issue naming 528 | 5.0 -> 3.0 | 1.62 -> 1.55 | 4.88 -> 2.92 |
| /improve | issue | 8.0 -> 2.4 | 4.6 -> 1.0 | 7.0 -> 2.05 |
| /needs-you | session | 4.0 -> 0.0 | 1.1 -> 0.05 | not run |
| /flow | session | 4.0 -> 0.0 | 1.9 -> 0.05 | not run |
| /improve | session | 8.0 -> 0.4 | 4.6 -> 0.15 | not run |
| /issues/528 | session naming 528 | 5.0 -> 1.0 | 1.62 -> 0.47 | not run |

DOM mutations in a 10 s window on /improve: 96 -> 0 (1 Hz, 1x), 210 -> 0 (4 Hz, 1x); at 4x CPU 87 -> 4 (1 Hz), 282 -> 0 (4 Hz). On /needs-you, /flow: 1-3 -> 0. On /issues/528: 2 -> 0-3 at 1x, 8 -> 6 at 4x (its elapsedMs changes in the API for a working session: a real change). Long tasks in every window: 0. Main-thread task time, /improve 4 Hz: 194 -> 68 ms (1x), 1086 -> 430 ms (4x).

Per-endpoint check (byUrl) that `affected` is what runs:
- `issue` event: /v1/needs and /v1/flow on every list route, plus /v1/issues/528 only when the event names 528; the four aggregates once per 10 s window on /improve (2 s debounce); accounts and machine only once each, from their own 15 s poll.
- `session` event: no /v1/needs, no /v1/flow; /v1/issues/528 only when it names 528; the aggregates once on /improve (kpis, friction, finding-classes, fix-commits); nothing else.
- The 4 Hz window issues at most about one refetch per endpoint per second (max wait 1 s): 17-21 per endpoint in 10 s at 1x, 37-39 at 4x CPU where each response takes longer. At 4 Hz on /issues/528 at 1x the lists and the Issue each refetch ~20 times; the old trailing debounce skipped many refetches by starving, so the count per event there is only slightly better (1.62 -> 1.55). Nothing got worse.
