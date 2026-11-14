# Test steps at background priority: the taskpolicy test (tp-slots)

Question: may `factory slot run` start its command under `taskpolicy -b` so that a full test load leaves the interactive
sessions on the mini responsive? The plan row allowed it only once a test on this host showed that.

Result: **no. `-b` keeps the host responsive, but a step under it gets a tenth of the CPU it would otherwise get, which would
hold the slots ten times as long. Steps stay at normal priority.**

## Method

Mac mini, Apple M2 Pro, 12 cores (8 performance, 4 efficiency), 2026-11-14, other leads running (load 5 to 23 during the test).
Two measurements, each 10 to 14 seconds:

- **Responsiveness**: a probe that, for 10 seconds, sleeps 5 ms and records how late it wakes, and spawns `/usr/bin/true` and
  records the time, while 12 busy loops (one per core) run under a policy.
- **Throughput**: N busy loops under a policy for 4 seconds, the iterations of all summed (millions), N = 4 and 12.

## Responsiveness under 12 busy loops

| Policy | wake p99 ms | spawn p50 ms | spawn p99 ms |
|-|-|-|-|
| none (idle host) | 1.8 to 2.4 | 1.6 to 1.7 | 4.2 to 6.8 |
| `taskpolicy -b` | 1.7 | 1.7 | 4.2 |
| `taskpolicy -c utility` | 3.1 | 2.7 | 7.2 |
| `nice -n 10` | 4.1 | 3.0 | 7.7 |
| normal priority | 5.2 | 2.7 | 12.5 |

## Throughput of the loops

| Policy | 4 loops | 12 loops |
|-|-|-|
| normal | 380 M | 490 M |
| `taskpolicy -b` | 36 M (9 %) | 15 M (3 %) |
| `taskpolicy -c utility` | 244 M (64 %) | 138 M (28 %) |
| `nice -n 10` | 381 M (100 %) | 458 M (93 %) |

A single loop on the host as it was: normal 118 M, `-b` 24 M (20 %). `-b` pins the process to the efficiency cores and throttles
it; exit codes and signals pass through (`taskpolicy -b sh -c 'exit 7'` exits 7, a SIGTERM exits 143).

## Reading

`-b` fully protects the interactive latency and costs 80 to 97 % of the step's speed, so a 5-minute check would take 25 to 50.
The slot wait p90 is the figure this row exists to cut, and longer holds raise it. `-c utility` costs a third to two thirds
and protects less; `nice` costs nothing and protects almost nothing (macOS ignores it for most scheduling). The load that
hurts the sessions is the number of steps at once, which the slot aim now bounds by the host's own pressure, so no priority
is applied. Revisit if a lead's session stalls while the aim is at its ceiling.
