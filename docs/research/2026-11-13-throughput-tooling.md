# Throughput tooling on the mini: per-process metrics, memory pressure, admission, CI metrics, offloading

**Status:** research input to the Spec "Throughput loop: measure, account, control, improve" (Issue 1044, verdict with notes, 2026-11-13). agw research run `01a1d630-ac91-77cc-8e4a-2d69bdcf1105`, 78 citations. Committed as returned; the items the run could not verify are listed under "Unverified" below and marked there, so a claim on that list is a lead to test on the host, not a fact.

## Bottom line

- **Per-process metrics:** Build a small libproc sampler that walks only the factory's own process trees and sends OTLP to the existing ClickStack collector. Off-the-shelf exporters cannot attach your labels, and on macOS most of them omit per-process disk and footprint data.
- **Memory pressure:** Gate new work on `kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical) plus the growth of swap used. Activity Monitor's 'Memory Used' has an undocumented formula and Apple publishes no numeric thresholds.
- **Admission control:** No existing tool gives a live, pressure-aware controller on macOS. Adopt the AIMD pattern from Netflix concurrency-limits, keyed on the pressure level, and lower the build tree's priority with `taskpolicy -b` or a background QoS clamp. Linux PSI, `ulimit -v` and RLIMIT_RSS caps do not transfer.
- **CI metrics:** Use DORA's five metrics, plus queue time, p90 duration, flake rate and failed-run waste. Use the OTel `cicd.*` names, noting their 'Mixed' stability. Ingest JUnit XML with a short script rather than buying a platform.
- **Cost reduction:** The biggest wins are worker caps and affected-only runs in Bun and Playwright, TypeScript 7 (native compiler, GA July 2026), Xcode's opt-in compilation cache, and per-test Postgres template clones. Claude Code stdio MCP servers live and die with each session, so the practical fix is to reduce how many sessions start a browser.
- **Offloading:** GitHub's macOS 3-core runner is $0.062/min and Depot's 8-CPU macOS runner is $0.08/min. Linux checks belong on the VPS runner. xcodebuild and simulators stay on Apple hardware, which is available to rent only from vendors and is capacity-constrained.

One correction to the background: `ri_energy_nj` is in `rusage_info_v6`, not v4. v4 has `ri_billed_energy` and `ri_serviced_energy`.

## 1. Per-process metrics on macOS

**What the kernel exposes.** `proc_pid_rusage` returns a struct whose layout grows with the flavour. v0 has `ri_phys_footprint`. v2 adds `ri_diskio_bytesread` and `ri_diskio_byteswritten`. v3 adds CPU time per QoS class. v4 adds `ri_lifetime_max_phys_footprint`, `ri_interval_max_phys_footprint`, `ri_billed_energy`, `ri_serviced_energy`, `ri_instructions`, `ri_cycles`, `ri_logical_writes` and `ri_runnable_time`. v6 adds `ri_energy_nj`, `ri_penergy_nj` and `ri_neural_footprint` (XNU's `bsd/sys/resource.h`, Apple's rusage_info_v4 page).

**Footprint vs RSS.** Physical footprint counts compressed and swapped dirty pages and excludes clean shared pages. It is what Activity Monitor shows, and it is not comparable to Linux RSS (isotop's macOS sampling notes). gopsutil's darwin code already wraps v4 to return physical footprint, peak footprint and disk read/write bytes, and leaves other I/O fields at zero. Use it as a reference implementation.

**Permissions.** isotop's notes say `proc_pidinfo` returns EPERM for other users' processes, while same-user processes are readable. The background says `top` reads root daemons' footprint without root, so the limit is per call. Test each call you depend on. The factory's own children are same-user, so the limit should not bite.

**Tool by tool.**

- **OTel Collector hostmetrics `process` scraper.** Supports Mac. Emits `process.cpu.time`, `process.disk.io`, `process.memory.usage` (physical memory, Beta) and `process.memory.virtual`. Paging faults, context switches and signals are Linux-only. The receiver sets no resource attributes, so project or step labels cannot come from it. The docs do not say which darwin field backs `process.memory.usage`, so treat it as unverified. Its `mute_process_*_error` flags suggest permission failures are expected for unreadable processes.
- **node_exporter.** Darwin collectors are host-level only (cpu, diskstats, filesystem, loadavg, meminfo, netdev, thermal, boottime). The `processes` collector is Linux-only. Not usable per process.
- **process-exporter.** Reads `/proc`, so Linux only.
- **Telegraf procstat.** Runs on Darwin and supports pid, user and pattern tags. The README marks `disk_read_bytes`, `disk_write_bytes` and `num_fds` as Linux-only (or root-dependent). So no macOS disk I/O from procstat.
- **Netdata apps.plugin.** Groups macOS processes automatically by app bundle, framework and daemon, sampled every second. PSS sampling is Linux-only. Its own store means a second metrics stack, and I did not verify any ClickHouse export path.
- **Beszel.** Host and container metrics only, with no per-process metrics in its README.
- **Glances 5 (beta).** Process list and REST/MCP API. Its export extra includes clickhouse-connect, but I did not verify per-process export. The stable line is 4.5.9.
- **osquery.** The Darwin `processes` table includes `resident_size`, `wired_size`, `total_size`, user and system time, and disk bytes read and written. It is good for ad hoc queries, but I did not verify a time-series path into ClickHouse.
- **macmon.** No sudo. Its TUI shows per-process CPU, memory, power and GPU. Its `serve`/Prometheus output is system-wide only. mactop, asitop and powermetrics need root.
- **footprint.** Refuses root-owned pids without root, per the background.

**Recommendation (build).** Enumerate descendants of the factory's session pids, which the factory already knows, and call `proc_pid_rusage` on each at 1 to 5 s. Record physical footprint, lifetime peak, disk bytes, CPU time and energy where the kernel supports v6. Attach labels from the factory's own step IDs. Send metrics to the existing OTel collector. Keep metric labels bounded (project, step, slot) and put issue and run IDs in trace or log attributes to avoid series explosion. The cost is unmeasured. Benchmark it against the background's 0.37 CPU-seconds per `top` call.

## 2. macOS memory pressure as a control signal

**Signals.**

- `kern.memorystatus_vm_pressure_level` takes 1 (normal), 2 (warning) or 4 (critical). It is a level, not a stall percentage, so it is coarse (ole-to-x issue 15, citing XNU `kern_memorystatus_notify.c`; isotop).
- Apple says memory pressure is determined by free memory, swap rate, reserved memory and file-backed cache (Apple's Activity Monitor guide, German page). It gives no thresholds.
- A reverse-engineering reading of XNU `vm_pageout.c` says the kernel moves to warning when compressor pages outnumber active, inactive, speculative and free pages together, with hysteresis. This is secondhand and medium confidence.
- Swap used comes from `vm.swapusage` (`xsu_used`). Compressed memory is `compressor_page_count`, which vm_stat prints as 'Pages occupied by compressor' (ole-to-x).
- Not verified here: compression and decompression rate counters, `kern.memorystatus_level`, and swap-in/out counters beyond the above. Check them on the host with `sysctl -a | grep -i memorystatus` and `vm_stat`.

**Activity Monitor.** Apple names the parts of 'Memory Used' (App, Wired, Compressed) but not the formula. A reverse-engineered mapping is App = (internal pages minus purgeable) times page size, Wired = wire_count, Compressed = compressor pages. One M1 calibration showed the parts summing about 0.55 GB short of the displayed total, and the gap is unresolved (ole-to-x issue 15). Do not use 'Memory Used' as a control signal.

**Thresholds.** Apple's colour labels, as quoted secondhand in ole-to-x, are 'using all of its RAM efficiently' (green), 'might eventually need more RAM' (yellow) and 'needs more RAM' (red). No numbers are published.

**Suggested gate (build).** Admit new heavy work only when the level is 1, swap used has not grown over the last N minutes, and compressor pages are flat. At level 2, stop admitting. At level 4, pause the lowest-priority work. Calibrate N with the factory's existing per-minute samples. Do not invent thresholds.

**Swap and disk.** Swapfiles live under `/private/var/vm` on older systems and under `/System/Volumes/VM` on current ones (dotfiles macOS swap note). `dynamic_pager`'s only documented option is `-F`, the swapfile base name. Its config is the system LaunchDaemon `/System/Library/LaunchDaemons/com.apple.dynamic_pager.plist` (man page, 2003 vintage). So moving swap to an external SSD requires root edits to a system plist. I found no Apple statement that supports it, so treat it as unsupported. I also found no Apple document on what happens when the boot volume runs low. One user report links 'LOW swap space' with 11 swapfiles and a full disk during watchdog panics (claude-mem issue 3012). That is an anecdote.

**fseventsd.**

- Budget: `launchctl print system/com.apple.fseventsd` shows 'jetsam memory limit (active, soft) = 30 MB'. The limit is soft and nothing enforces it (talkstream write-up).
- Reports: 24 GB on an M3 Pro, 18 GB, macOS 27.0 (talkstream). 42 GiB on a 36 GiB Mac on macOS 26.6.2 (owebeeone, claude-code 98769). 14 GB after about 26 hours on a 32 GB MacBook Pro running macOS 27.0.1 (ww2283). Reporters also cite daintree 12455 (36 GB).
- Cause: unproven. Hypotheses include per-client state growing under FSEvents register/unregister churn (daintree, self-labelled not proven). Colima mounting the whole home directory writable is another reported trigger (colima 1569). One machine with 31 idle headless claude processes stayed at 6.6 MB, so process count alone does not trigger it.
- Fix: `kickstart` is refused by SIP. `sudo kill -TERM` works and launchd respawns the daemon. Because the daemon is root-owned, a non-root collector can detect the problem but not fix it. A root LaunchDaemon (talkstream describes one) or a manual restart is needed. Apple feedback FB25046068 was filed by talkstream; I did not verify it.

**watchdogd panics.** 'watchdog timeout: no checkins from watchdogd' means the kernel was starved, not that memory ran out.

- claude-code 106745 (2 Nov 2026): two panics 13 minutes apart on a Mac17,7 with 128 GB and macOS 27.2, with 706 git processes, a 1.4M-file repository, kernel_task at priority 91, and compressor at 16%. Memory was not under pressure.
- claude-code 39253 (March 2026): a user says jetsam killed watchdogd on an 18 GB M3 Pro with several Claude Code instances. One report.
- MLX issue 3267: the Metal GPU watchdog kills long training jobs.
- Implication: a memory gate alone will miss process-fan-out and vnode storms. Add a cap on concurrent git and filesystem-heavy processes.

## 3. Admission control and dynamic concurrency

| Tool | What it reads | Fit on this Mac |
|---|---|---|
| GNU make `-l` | load average | Crude CPU gate. Starts no new jobs when load is at or above N. |
| GNU make jobserver, Ninja 1.13+ | shared job slots | Ninja follows make's FIFO jobserver (make 4.4+) and still enforces `-l`. Good for nested builds. |
| Ninja pools | static | Static caps per rule. |
| Bazel `--local_cpu_resources`, `--local_ram_resources`, `--local_resources` | static budgets | Static. `--macos_qos_class=background` lowers the server. `--shutdown_on_low_sys_mem` works on Linux and macOS when idle. `--batch_cpu_scheduling` and `--io_nice_level` are Linux-only. |
| Nix `max-jobs`, `cores` | static | `max-jobs` is independent of the `cores` build hint. |
| GNU parallel `--memfree`, `--noswap`, `--load`, `niceload` | free memory, swapping, load | The cheapest adaptive option. Whether `--memfree` reads macOS memory correctly is unverified; test before relying on it. |
| Linux PSI | cpu, memory, io stall | Linux-only. macOS has the pressure level and no CPU or I/O pressure counterpart (isotop). |
| Netflix concurrency-limits | latency and loss as congestion signals | Java library, but the algorithms transfer: AIMD, Vegas, Gradient2, with a BlockingAdaptiveExecutor. |
| Kubernetes VPA | learned usage | Not checked. Assume it does not transfer. |
| Buck2 | | Not checked. |

**Design (build).**

- AIMD on heavy-slot count. On pressure level 2, halve the running heavy steps (minimum 1). After 60 s at level 1 with flat swap, add one slot. Cap at a static ceiling. Netflix's AIMDLimit is the reference for the shape.
- Admit a new step only if its learned per-repo peak plus the running steps' peaks fits the budget. The factory already has this.
- Cap fan-out per resource type (git status, mutation runs, Docker). Watchdog reports show that process storms are the failure mode, not memory alone.

**macOS mechanisms without root.**

- `taskpolicy -b` puts a process tree in the background (PRIO_DARWIN_BG), which lowers CPU, disk and network priority. `taskpolicy -c background|utility` clamps QoS, and `-d`/`-g` set disk I/O policy. These are in the taskpolicy man page (2013 vintage). The background-QoS behaviour is documented; I did not test it on macOS 26.
- LaunchAgents (no root) accept `SoftResourceLimits` and `HardResourceLimits` keys, including CPU and process count. Memory caps are weak. Darwin accepts RLIMIT_AS and RLIMIT_DATA but does not enforce them (llm-cad issue 38, 2026). `ulimit -v` does not work (Stack Overflow, 2011). KiroCrew says it has no macOS memory ceiling.
- `taskpolicy -m` (MiB) and `-j` (jetsam priority) appear in the man page. I did not verify that they are enforced on macOS 26. Listing the jetsam priority list needs root (isotop).

**Not worth adopting for this Mac:** `ulimit -v` or RLIMIT_RSS as a memory cap; PSI; VPA; `memorystatus_control` (root); GNU parallel `--memfree` until it is tested here.

## 4. CI and test efficiency metrics

**DORA.** The five metrics are change lead time, deployment frequency, failed deployment recovery time, change fail rate and deployment rework rate. DORA says to apply them per application or service, not across apps. For a single factory, queue time, duration percentiles, flake rate and time-to-green matter more.

**Google.** A 2016 Google Testing Blog post reports about 1.5% of all test runs giving a flaky result. Google's 'State of CI' slides say almost 16% of 4.2M tests have some flakiness. In one month, 84% of Pass-to-Fail transitions came from flaky tests, and only 1.23% of tests ever caught a breakage. Google's mitigation was to rerun only tests marked flaky, and to keep flaky tests out of the gating path.

**Vendors.**

- **Datadog Test Optimization.** Flaky Tests Management shows CI time wasted and failure rate per test. Test Impact Analysis runs only the tests affected by a change. Hosted SaaS; pricing not checked.
- **Trunk Flaky Tests.** Ingests JUnit XML. Quarantines by overriding exit codes at runtime. Test collections with separate settings.
- **BuildPulse.** Ingests JUnit XML with no SDK. Ranks flaky tests by engineering time and quarantines them. Pricing not checked.
- **Develocity.** Flaky detection within a build (retry-based) and across builds. Priced per committer per year.
- **Buildkite Test Engine.** Detects flakiness from historical data, quarantines flaky tests and splits tests by timing. Its client bktec is open source.

**OpenTelemetry CI/CD conventions** (semconv 1.45.0; the page's status is 'Mixed', so check stability per attribute).

- Metrics: `cicd.pipeline.run.duration` (histogram, s), `cicd.pipeline.run.active`, `cicd.worker.count`, `cicd.pipeline.run.errors`, `cicd.system.errors`.
- `cicd.pipeline.run.state` takes `pending`, `executing` and `finalizing`. Pending covers queue time and provisioning, so queue time comes from the state change.
- `cicd.pipeline.result` takes success, failure, timeout, cancellation, error or skip. A test failure is 'failure', not 'error'.
- Pipeline-run entities are opt-in because they raise cardinality. Put run IDs in traces, not metric labels.

**Span tools.**

- `otel-cli` sends spans from shell scripts. It runs in non-recording mode without an endpoint and recommends a localhost collector. Good fit for ClickStack.
- `honeycombio/buildevents` builds CI traces in build, step and cmd modes. It targets Honeycomb's API (`BUILDEVENT_APIHOST`), not generic OTLP. Skip it unless the endpoint is compatible with ClickStack, which I did not verify.

**Ingesting test results.**

- Bun: `bun test --reporter=junit --reporter-outfile=...`, or set `[test.reporter] junit` in bunfig.toml.
- Playwright: the `junit` reporter, `blob` reporter with `merge-reports` for shards, and `--shard=x/y`.
- pytest's `--junitxml` and xcodebuild's `.xcresult` bundles were not checked here.
- Working templates exist: groundcover's GitHub Action exports workflow runs and JUnit summaries as OTel spans, and PostHog's `report_test_timings.py` emits OTLP traces from JUnit XML. Adapting one to ClickStack is probably a day's work. I did not run either.

**Recommendation.** Build a JUnit-to-OTLP ingester for Bun, Playwright and pytest results. Use the `cicd.*` names for run and task outcomes. Do not buy a flake platform until the flake cost is measured from your own data. Trunk or BuildPulse are the low-cost way to try one.

## 5. Reducing the cost itself

- **Bun test.** `--parallel` runs workers and forwards flags such as `--timeout` and `--preload`. Keep the JUnit reporter so CI and ClickStack see the same results.
- **Playwright.** Set `workers` explicitly (2 to 4 on a 12-core, 32 GiB machine is a starting guess to measure). Shard across machines with `--shard`, not on one Mac.
- **TypeScript 7.0.** Microsoft released TypeScript 7.0 as a native Go port on 8 July 2026. Microsoft claims about 10x faster builds. A secondary source reports 8x to 12x on full builds. Run it as the typecheck step and confirm it accepts your tsconfigs.
- **Affected-only runs.** Nx's `nx affected` and Datadog Test Impact Analysis do this. Turborepo caches tasks locally and can share a remote cache, which is free and has a documented self-hosted API (OpenAPI spec). Nx Cloud distributes tasks across agents.
- **Xcode.** Xcode 26 added an opt-in compilation cache for Swift and C-family code, switched on with `COMPILATION_CACHE_ENABLE_CACHING`. Depot's cache serves it remotely.
- **sccache.** Shared cache for C, C++ and Rust. `sccache-dist` adds a scheduler and build servers. Not relevant to Swift.
- **Postgres template databases.** `CREATE DATABASE x TEMPLATE y` clones a database. The source must have no other sessions connected while copying, so build one migrated template per schema version and clone it per test run.
- **Browsers and MCP.** Claude Code stdio servers are started by the session and stopped when it disconnects (SIGINT, then SIGTERM after 100 ms, then SIGKILL). So 20 sessions means 20 MCP processes. Scopes (local, project, user) control where a server is configured, not whether it is shared. The documented route to one server for many clients is the HTTP transport. Tool search defers tool schemas to save context, not processes. chrome-devtools-mcp starts Chrome only when a tool needs one. Its CLI runs one background daemon reused across commands, headless and isolated by default, with `--userDataDir` for persistence. Options to test: (a) drop chrome-devtools from sessions that do not need a browser, using project scope; (b) use the CLI skill for browser tasks; (c) connect to one running Chrome, which the README mentions but I did not verify. Unverified: whether several agent sessions can use the CLI daemon at once.

## 6. Offloading from the Mac

**GitHub-hosted (published rates, 12 Nov 2026).**

- macOS 3-core (M1 or Intel): $0.062 per minute.
- macOS 5-core (M2 Pro) larger runner `macos_xl`: $0.102 per minute. Larger runners are available only on Team and Enterprise Cloud plans.
- Linux 2-core x64: $0.006. Linux 2-core arm64: $0.005. Linux 1-core `slim`: $0.002, which GitHub bills at a 15-minute cap (per the latchkey summary).
- Self-hosted runners: GitHub announced a $0.002 per-minute cloud platform charge on 16 Dec 2025 and postponed it the next day. Per a secondary summary of the changelog, no fee applies today. Re-check before budgeting.

**Depot.**

- macOS: $0.08 per minute for an 8-CPU, 24 GB runner (M2 on macOS 14 and 15, M4 on macOS 26), with a 2 GB disk accelerator. Depot says macOS capacity is not fully elastic because of Apple licensing, so queues can grow at peak.
- Linux: $0.006 per minute for the 2-vCPU base runner, with minute multipliers for larger runners. Plans are $20 and $200 a month with included minutes.
- A 2024 Depot post claimed half the cost of GitHub macOS runners. That is a vendor claim from before the 2026 price changes.

**Other vendors.** Aggregator tables put Blacksmith, WarpBuild and Namespace at about $0.004 per minute for a 2-vCPU Linux runner. These are secondary and unverified; macOS prices were not checked. One comparison site says BuildJet is shutting down. Treat that as a lead.

**Recommended split.**

- Keep on the Mac: xcodebuild, iOS simulators, and anything that needs local Xcode state.
- Move to the Linux VPS runner or a second Linux VPS: oxlint, oxfmt, `tsc`, Bun tests, pytest, and non-headed Playwright.
- For remote caches, use a self-hosted Turborepo cache server. Use sccache-dist only for Rust. Bazel remote execution and Docker remote contexts were not checked.
- Narrow the Colima mount to the project directories. This is the mitigation talkstream and colima 1569 point to for fseventsd.
- Cost sanity check: a 10-minute macOS job costs $0.62 on GitHub's 3-core runner and $0.80 on Depot's 8-CPU runner. Local runs have no marginal cost but consume the Mac's memory budget.

## Adopt, build, do not adopt

- **Adopt:** the libproc rusage fields; the kernel pressure level and swap-growth gate; `taskpolicy -b` and QoS clamps; Netflix's AIMD algorithm; OTel `cicd.*` names; the existing ClickStack collector; affected-only runs; the Xcode compilation cache; TypeScript 7; Postgres template clones.
- **Build:** the per-process sampler over the factory's trees; the AIMD slot controller; a JUnit-to-OTLP ingester; optionally a root LaunchDaemon for the fseventsd and watchdog guard.
- **Do not adopt:** node_exporter, process-exporter or Beszel for per-process data; Netdata as a second metrics stack; powermetrics, mactop or asitop (sudo); memory rlimits or `ulimit -v`; PSI; VPA; Honeycomb buildevents for ClickStack; sccache-dist for Swift.

## Confidence and open items

High confidence: the rusage field layout, the pressure-level values, the GitHub and Depot published rates, the TypeScript 7 release date, the Postgres template constraint, and the Claude Code stdio lifecycle.

Medium: the XNU warning-transition logic (secondhand), the fseventsd and watchdog reports (single-user anecdotes, several on macOS 27, which the user is not on), and Google's 2016 numbers (blog post plus search snippet).

Low or unverified: the Activity Monitor formula, the darwin field behind `process.memory.usage`, `kern.memorystatus_level`, taskpolicy `-m` and `-j` on macOS 26, the cost of the sampler, the GNU parallel memory checks on macOS, whether the CLI daemon supports concurrent sessions, and the Buck2, VPA, pytest and xcodebuild details.


## Unverified

The run named these as not verified. Each is a lead, to be measured on the host before a rule depends on it.

- **UNVERIFIED: OTel hostmetrics darwin field behind process.memory.usage (RSS vs physical footprint).** Docs do not name the darwin source field; the scraper source file was not retrievable (404). (https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/processscraper/documentation.md)
- **UNVERIFIED: kern.memorystatus_level, compression and decompression counters, swapin and swapout counters.** Not found in any fetched source; check with sysctl and vm_stat on the host.
- **UNVERIFIED: taskpolicy -m memory limit and -j jetsam priority on macOS 26.** Only the 2013-era man page was read; behaviour on macOS 26 not tested. (https://keith.github.io/xcode-man-pages/taskpolicy.8.html)
- **UNVERIFIED: taskpolicy -b and QoS clamp effect on a process tree on macOS 26.** Documented, but no runtime test was done. (https://keith.github.io/xcode-man-pages/taskpolicy.8.html)
- **UNVERIFIED: Per-process sampler cost on this Mac.** Needs measurement against the background's top baseline.
- **UNVERIFIED: GNU parallel --memfree, --noswap and niceload on macOS.** Options confirmed in the manual; not confirmed to read macOS memory and swap correctly. (https://www.gnu.org/software/parallel/man.html)
- **UNVERIFIED: Whether several Claude Code sessions can share one chrome-devtools CLI daemon concurrently.** Docs describe one background daemon; concurrency across sessions not described. (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md)
- **UNVERIFIED: Whether chrome-devtools-mcp supports an HTTP transport that multiple sessions can share.** README describes stdio; no HTTP mode was found in the read pages. (https://github.com/ChromeDevTools/chrome-devtools-mcp)
- **UNVERIFIED: Glances per-process export to ClickHouse.** Export extra lists clickhouse-connect; per-process export not confirmed. (https://github.com/nicolargo/glances)
- **UNVERIFIED: Netdata export to ClickHouse.** Not checked; treated as a second metrics stack.
- **UNVERIFIED: Buck2 local resource control.** Not checked in this run.
- **UNVERIFIED: Kubernetes VPA learned requests.** Not checked in this run.
- **UNVERIFIED: pytest --junitxml and xcodebuild xcresult to JUnit conversion.** Not checked in this run.
- **UNVERIFIED: Bazel remote execution and Docker remote context for offloading.** Not checked in this run.
- **UNVERIFIED: Namespace, Blacksmith and WarpBuild macOS prices.** Only aggregator Linux prices were read; no vendor page checked. (https://avrea.com/github-actions-runner-pricing)
- **UNVERIFIED: Whether BuildJet is shutting down.** Single comparison-site claim. (https://runs-on.com/alternatives-to/github-actions-runners/)
- **UNVERIFIED: Whether GitHub's self-hosted runner charge is still postponed.** Based on a secondary summary; GitHub's changelog itself was not read. (https://latchkey.dev/learn/cost/github-actions-pricing-changes-2026)
- **UNVERIFIED: Stability of cicd.* attributes individually.** Page status is Mixed; per-attribute stability not checked. (https://opentelemetry.io/docs/specs/semconv/cicd/cicd-metrics/)
- **UNVERIFIED: Whether the fseventsd leak appears on macOS 26.** Reports are mostly macOS 27.x; one 26.6.2 report exists; not reproduced. (https://github.com/anthropics/claude-code/issues/98769)
- **UNVERIFIED: Apple's Feedback FB25046068 on fseventsd.** Reported by a third party; not checked with Apple. (https://github.com/talkstream/fseventsd-runaway)
- **UNVERIFIED: Activity Monitor Memory Used formula.** Community reverse engineering with an unresolved gap. (https://github.com/ole-to-x/usage-bar/issues/15)
- **UNVERIFIED: BuildJet is shutting down (comparison page, a lead to verify).** cited, but the page was never retrieved this run (https://runs-on.com/alternatives-to/github-actions-runner-alternatives/)

## Citations

- [high] rusage_info_v4 includes ri_phys_footprint, ri_lifetime_max_phys_footprint, ri_diskio_bytesread/byteswritten, ri_billed_energy, ri_serviced_energy, ri_instructions, ri_cycles and ri_runnable_time. https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h
- [high] ri_energy_nj and ri_penergy_nj are in rusage_info_v6, not v4 as the background stated. https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h
- [high] rusage_info_v4 is available from macOS 11.0 and lists per-process fields. https://developer.apple.com/documentation/kernel/rusage_info_v4
- [medium] Physical footprint counts compressed and swapped dirty memory and excludes clean shared pages, so it is not comparable to RSS; proc_pidinfo fails with EPERM for other users' processes except the short BSD info flavour. https://github.com/tfpickard/isotop/wiki/Theory-Sampling-macOS
- [high] gopsutil's darwin implementation returns DiskReadBytes and DiskWriteBytes from rusage v4, and PhysFootprint and PeakFootprint for memory; ReadCount and WriteCount stay zero. https://github.com/shirou/gopsutil/blob/master/process/process_darwin.go
- [high] OTel hostmetrics process scraper supports Mac and emits process.cpu.time, process.disk.io, process.memory.usage (Beta) and process.memory.virtual; context switches, paging faults and signals are Linux-only. https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/processscraper/documentation.md
- [high] The hostmetrics receiver sets no resource attributes, and process scraper mute_process_*_error flags exist for unreadable processes. https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/README.md
- [high] node_exporter Darwin collectors are host-level (cpu, diskstats, filesystem, loadavg, meminfo, netdev, thermal, boottime, uname); the processes collector is Linux-only. https://github.com/prometheus/node_exporter
- [high] process-exporter mines /proc and is a Linux tool. https://github.com/ncabatoff/process-exporter
- [high] Telegraf procstat runs on Darwin; disk_read_bytes, disk_write_bytes and num_fds are documented as Linux-only or root-dependent. https://github.com/influxdata/telegraf/blob/master/plugins/inputs/procstat/README.md
- [high] Netdata apps.plugin groups macOS processes automatically by app, framework and daemon; PSS sampling is Linux-only; charts show RSS. https://github.com/netdata/netdata/blob/master/src/collectors/apps.plugin/README.md
- [high] Beszel supports host and container metrics and has no per-process metrics in its feature list. https://github.com/henrygd/beszel
- [medium] Glances 5 is beta, stable is 4.5.9; the export extra includes clickhouse-connect; MCP server is built in. https://github.com/nicolargo/glances
- [medium] osquery's Darwin processes table includes resident_size, wired_size, total_size, user and system time, and disk bytes read and written. https://github.com/osquery/osquery/blob/master/osquery/tables/system/darwin/processes.cpp
- [high] macmon runs without sudo and shows per-process CPU, memory, power and GPU in its TUI; its pipe and serve outputs are system-wide; mactop and asitop require sudo. https://github.com/vladkens/macmon
- [low] mactop requires sudo. https://github.com/context-labs/mactop
- [medium] kern.memorystatus_vm_pressure_level values are 1 normal, 2 warning, 4 critical, from XNU kern_memorystatus_notify.c. https://github.com/ole-to-x/usage-bar/issues/15
- [high] Activity Monitor's pressure is determined by free memory, swap rate, reserved memory and file cache; Memory Used parts are App, Reserved, Compressed, Cached Files and Swap Used. https://support.apple.com/de-de/guide/activity-monitor/actmntr1004/mac
- [medium] Activity Monitor's Memory Used formula is not documented; reverse-engineered App = internal minus purgeable pages; an M1 calibration left a 0.55 GB gap. https://github.com/ole-to-x/usage-bar/issues/15
- [low] Apple's green, yellow and red labels mean using RAM efficiently, might need more RAM, needs more RAM (quoted secondhand). https://github.com/ole-to-x/usage-bar/issues/15
- [low] The kernel moves to Warning when compressor pages outnumber active, inactive, speculative and free pages, with hysteresis (reading of vm_pageout.c). https://github.com/ole-to-x/usage-bar/issues/15
- [high] The Mac's pressure level is a level, not a stall percentage, and CPU and I/O pressure have no macOS counterpart. https://github.com/tfpickard/isotop/wiki/Theory-Sampling-macOS
- [high] dynamic_pager's only documented option is -F, the swapfile base name; its config is /System/Library/LaunchDaemons/com.apple.dynamic_pager.plist; default swapfile base is /private/var/vm/swapfile. https://keith.github.io/xcode-man-pages/dynamic_pager.8.html
- [low] Swapfiles on current macOS are under /System/Volumes/VM. https://github.com/daviddwlee84/dotfiles/blob/main/docs/tools/macos-swap.md
- [low] A user report links LOW swap space and 11 swapfiles with a full disk to watchdog starvation panics. https://github.com/thedotmack/claude-mem/issues/3012
- [medium] fseventsd jetsam soft memory limit is 30 MB; a 24 GB fseventsd and the fix sudo kill -TERM; launchctl kickstart refused by SIP. https://github.com/talkstream/fseventsd-runaway
- [medium] fseventsd reports: 42 GiB on a 36 GiB Mac under macOS 26.6.2; restart reset it. https://github.com/anthropics/claude-code/issues/98769
- [low] fseventsd 14 GB after about 26 hours on macOS 27.0.1; cause unknown; the daemon does not drain on its own. https://github.com/anthropics/claude-code/issues/98769
- [medium] watchdog timeout panics on 2 Nov 2026 with 706 git processes, kernel_task at priority 91, memory not under pressure, kern.maxvnodes 263,168. https://github.com/anthropics/claude-code/issues/106745
- [low] A user reports jetsam OOM killing watchdogd triggers a kernel panic on an 18 GB M3 Pro with several Claude Code instances. https://github.com/anthropics/claude-code/issues/39253
- [medium] GNU make -l: no new jobs start if other jobs are running and the load average is at least the limit. https://www.gnu.org/software/make/manual/html_node/Options-Summary.html
- [high] Ninja 1.13 follows the GNU make jobserver (FIFO, make 4.4+) and still enforces -l load limits; ninja has pools. https://ninja-build.org/manual.html
- [high] Bazel has --local_cpu_resources and --local_ram_resources (default HOST_CPUS) and --macos_qos_class (default, utility, background); batch_cpu_scheduling and io_nice_level are Linux-only; --shutdown_on_low_sys_mem works on Linux and macOS. https://bazel.build/reference/command-line-reference
- [high] Nix: max-jobs controls local parallel builds independently of the cores (NIX_BUILD_CORES) setting. https://nixos.org/manual/nix/stable/command-ref/conf-file.html
- [medium] GNU parallel offers --memfree, --noswap, --load and niceload. https://www.gnu.org/software/parallel/man.html
- [high] Linux PSI exposes cpu, memory and io pressure in /proc/pressure with trigger support. https://docs.kernel.org/accounting/psi.html
- [high] Netflix concurrency-limits provides Vegas, Gradient2 and AIMD limits and a BlockingAdaptiveExecutor. https://github.com/Netflix/concurrency-limits
- [medium] taskpolicy -b (PRIO_DARWIN_BG), -c QoS clamp, -d and -g I/O policies, and -m and -j documented in the man page. https://keith.github.io/xcode-man-pages/taskpolicy.8.html
- [medium] launchd jobs accept SoftResourceLimits and HardResourceLimits (CPU, NumberOfProcesses, etc.). https://keith.github.io/xcode-man-pages/launchd.plist.5.html
- [medium] On macOS RLIMIT_AS and RLIMIT_DATA are accepted and reported set but not enforced; memory caps are not enforced without root. https://github.com/MaximumTrainer/llm-cad/issues/38
- [medium] ulimit -v and RLIMIT_RSS do not work on OS X. https://stackoverflow.com/questions/3274385/how-to-limit-memory-of-a-os-x-program-ulimit-v-neither-m-are-working
- [low] A sandbox on macOS has no memory ceiling for the agent process tree. https://github.com/kirodotdev/KiroCrew/blob/main/docs/architecture/resource-protection.md
- [high] DORA's five metrics are change lead time, deployment frequency, failed deployment recovery time, change fail rate and deployment rework rate; apply per application or service. https://dora.dev/guides/dora-metrics/
- [medium] About 1.5% of all test runs reported a flaky result in the 2016 Google observation. https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- [medium] Almost 16% of 4.2M Google tests have some flakiness; 84% of pass-to-fail transitions come from flaky tests; 1.23% of tests ever found a breakage. https://static.googleusercontent.com/media/research.google.com/ru/pubs/archive/45880.pdf
- [medium] Datadog Flaky Tests Management shows impact metrics including CI time wasted and failure rate; Test Impact Analysis runs only the relevant tests. https://docs.datadoghq.com/tests/flaky_management/
- [high] Trunk Flaky Tests ingests JUnit XML and quarantines flaky tests by overriding exit codes at runtime. https://docs.trunk.io/flaky-tests/quarantining/index
- [medium] BuildPulse ingests JUnit XML with no SDK and ranks flaky tests by engineering time. https://buildpulse.io/products/flaky-tests
- [medium] Develocity detects flaky tests within a build and across builds; pricing is per committer per year. https://develocity.ai/pricing/
- [high] Buildkite Test Engine detects flaky tests from historical data, quarantines them, and splits tests; the bktec client is open source. https://buildkite.com/docs/pipelines/speed-up-builds-with-bktec
- [high] OTel CI/CD metrics include cicd.pipeline.run.duration (histogram), cicd.pipeline.run.active, cicd.worker.count, cicd.pipeline.run.errors and cicd.system.errors; the page status is Mixed; pipeline run entity is opt-in for cardinality. https://opentelemetry.io/docs/specs/semconv/cicd/cicd-metrics/
- [high] cicd.pipeline.run.state values pending, executing and finalizing; pending covers queue time; cicd.pipeline.result values include failure, error, timeout and cancellation. https://opentelemetry.io/docs/specs/semconv/registry/attributes/cicd/
- [high] otel-cli sends spans from shell scripts, runs non-recording without an endpoint, and recommends a localhost collector. https://github.com/equinix-labs/otel-cli
- [high] honeycombio buildevents sends CI traces to Honeycomb (BUILDEVENT_APIKEY, BUILDEVENT_APIHOST) in build, step and cmd modes. https://github.com/honeycombio/buildevents
- [high] Bun test writes JUnit XML with --reporter=junit and --reporter-outfile; bunfig can set test.reporter.junit. https://bun.com/docs/test/reporters
- [medium] Bun test --parallel forwards flags such as --timeout, --preload and --retry to workers. https://bun.com/docs/test/parallel
- [high] Playwright has junit and blob reporters, merge-reports for shards, and --shard=x/y. https://playwright.dev/docs/test-sharding
- [medium] groundcover's GitHub Action exports workflow runs as OTel spans and can parse JUnit XML summaries. https://github.com/groundcover-com/groundcover-github-action/
- [medium] PostHog's report_test_timings.py emits OTLP traces from JUnit XML artifacts. https://github.com/PostHog/posthog/blob/0622fb80/.github/scripts/report_test_timings.py
- [high] Microsoft released TypeScript 7.0 as the native Go port; it is described as 10x faster; GA 8 July 2026. https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- [low] A secondary source reports TypeScript 7.0 at 8x to 12x faster on full builds. https://ecorpit.com/typescript-7-migration-readiness-eslint-astro-blockers-2026/
- [high] Xcode 26 added opt-in compilation caching for Swift and C-family languages. https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes
- [high] The build setting COMPILATION_CACHE_ENABLE_CACHING caches compilation results. https://developer.apple.com/documentation/Xcode/build-settings-reference
- [medium] Depot Cache can serve Xcode compilation caching remotely. https://preview.depot.dev/blog/xcode-compilation-caching-with-depot-cache
- [high] Turborepo remote caching is free and can be self-hosted; the Remote Cache API is documented as OpenAPI. https://turborepo.dev/docs/core-concepts/remote-caching
- [medium] Nx Cloud distributes tasks across agents and nx affected scopes work to changed code. https://nx.dev/docs/kb/nx-vs-turborepo
- [medium] sccache-dist is a scheduler plus server design for distributed Rust and C/C++ compilation. https://docs.rs/crate/sccache/latest/source/docs/Distributed.md
- [high] CREATE DATABASE copies a template; no other sessions may be connected to the source while it is copied. https://www.postgresql.org/docs/current/manage-ag-templatedbs.html
- [high] Claude Code stdio servers are started by the session and signalled to stop when it disconnects (SIGINT, SIGTERM after 100 ms, SIGKILL after 400 ms more on macOS and Linux). https://code.claude.com/docs/en/mcp
- [medium] Claude Code supports local, project and user MCP scopes, HTTP transport, and tool search that defers tool schemas. https://code.claude.com/docs/en/mcp
- [high] chrome-devtools-mcp starts the browser only when a tool needs one; connecting the MCP server alone does not start a browser; headless and isolated defaults. https://github.com/ChromeDevTools/chrome-devtools-mcp
- [high] The chrome-devtools CLI uses one background daemon reused across commands; headless default; isolated unless userDataDir is set. https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md
- [high] GitHub-hosted macOS 3-core (M1 or Intel) costs $0.062 per minute; Linux 2-core x64 $0.006; Linux 2-core arm64 $0.005; Linux 1-core slim $0.002; macOS 5-core M2 Pro larger runner $0.102; larger runners require Team or Enterprise Cloud. https://docs.github.com/en/billing/reference/actions-runner-pricing
- [low] GitHub announced a $0.002 per minute self-hosted runner charge on 16 Dec 2025 and postponed it on 17 Dec 2025; no new date published; the billing docs still list self-hosted runners as free as of 12 Nov 2026 (secondary summary). https://latchkey.dev/learn/cost/github-actions-pricing-changes-2026
- [high] Depot macOS runners are 8 CPU, 24 GB, $0.08 per minute; M2 for macOS 14 and 15, M4 for macOS 26; capacity is not fully elastic because of Apple licensing. https://depot.dev/docs/github-actions/runner-types
- [high] Depot Linux 2-vCPU base runner is $0.006 per minute; Developer plan $20 per month; Startup $200 per month. https://depot.dev/pricing
- [low] Depot said in 2024 its macOS runners cost half of GitHub-hosted macOS runners (vendor claim, pre-2026 pricing). https://depot.dev/blog/mac-github-actions-runners
- [low] Blacksmith, WarpBuild and Namespace price about $0.004 per minute for a 2-vCPU Linux runner (aggregator tables, unverified). https://avrea.com/github-actions-runner-pricing

