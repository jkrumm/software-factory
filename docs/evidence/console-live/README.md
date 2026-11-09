# Console: stays current, stops lagging (Issue 528)

Measured on the mini with headless Chrome driven over CDP, 1800x1200, a fresh browser context per route (cold cache),
`load` plus a 4 s settle. "1x" is the mini unthrottled, "4x" is CPU throttled 4x. An interaction time is the input to the
second animation frame (the floor is about 16 ms). The scripts are `measure.mjs` (cold load), `interact.mjs` (Cmd+K,
expand a card, toggle a section) and `storm.mjs` (change events injected into the page's own `EventSource` at 1 and 4 per
second for 10 s, counting `/v1` requests and DOM mutations). The stream carried no organic change events during the
measurements, so the storm is injected.

- `before/`: master before the change. `report.md` is the table per route.
- `after/`: a build of the change served against the live API. `after/report.md` has the before and after comparison;
  `after/real-frames/` re-runs the storm with frames in the server's wire format (the data carries no cursor).
- `live-after/`: the deployed release `762ff03`, same scripts against `127.0.0.1:7795`.

## Why the page stayed empty

A long-lived tab or installed app kept an old bundle against a newer server. The service worker was only checked on
navigation, so a changed answer shape failed every query's parse and Needs you stayed at "No data yet" until a hard
reload. A half-open stream also looked "Live" with polling off, because the keepalive is an SSE comment that
`EventSource` cannot see.

## After, in numbers

| measure | before | after (build of the change) | live, deployed |
|-|-|-|-|
| `/v1` requests per `issue` change on Needs you and Flow, 1 per second | 4.0 | 2.0 | 2.0 |
| `/v1` requests per `issue` change on Improve, 1 per second | 8.0 | 2.4 | 2.4 |
| `/v1` requests per `session` change on Needs you and Flow | 4.0 | 0 | not run |
| DOM mutations on Improve in 10 s, 1 per second | 96 | 0 | 2 |
| DOM mutations on Improve in 10 s, 4 per second | 210 | 0 | 0 |
| cold-load `/v1` requests, Needs you and Flow | 9 | 5 | 5 |
| cold-load `/v1` requests, Improve | 17 | 9 | 9 |
| storm long tasks (over 50 ms) | 0 | 0 | 0 |
| card expand and section toggle, median | 31-34 ms | 31-32 ms | see `live-after/ix.json` |
| Cmd+K median on Needs you | 16.7 ms | 9.6 ms | see `live-after/ix.json` |

## What did not improve

- **The first paint is unchanged in kind.** Unthrottled, nothing on the first route exceeds 50 ms of main-thread work
  (the longest task is 34-38 ms), so the 140-197 ms boot long tasks seen at 4x CPU did not shrink beyond run noise.
- **The deployed bundle is not smaller than before.** On the same code the palette and dagre moved out of the entry
  chunk (859 KB to 675 KB raw, 245 KB to 194 KB transferred). The release that went live also carries the Console kit
  that landed on master in between, so its entry chunk is 786 KB raw and the JS transferred on Needs you is 244 KB
  against 241 KB before. The split is still correct; the kit's weight is the next thing to look at.
- **Chain loads slower.** Its LCP rose from 372 to 452 ms at 1x because dagre now loads with the graph chunk.
- **Lists are not virtualised beyond Flow.** The real sizes are 2 needs, 6 open Issues, at most 30 timeline rows on one
  Issue and 11 KPI rows on Improve, so none is near the point where it matters.
- **The owner's "all UIs are hugely lagging"** does not reproduce in these traces: 0 long tasks at 1x on every route,
  on a laptop-like 4x throttle at most two boot tasks of 120-160 ms. What the owner saw on his own machine and data was
  not measured here.
