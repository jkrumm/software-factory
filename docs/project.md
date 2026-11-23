# project.yaml

A repo tells the factory how it ships in one file at its root, `project.yaml`. The factory reads it from the default
branch, so a change counts once it is merged. Every key is typed: the schema lives in
`packages/contract/src/project-file.ts`, and the JSON Schema, the editor hover and the key reference at the end of this page
are generated from it. A repo without the file is a work repo: no deploy, ship by push, no cap on leads, and it hears the
owner only. A repo that must not carry the file (colleagues review every PR) uses a host-local one: see "A host-local
file" below.

## A new repo's file

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/jkrumm/software-factory/master/schema/project.schema.json
apiVersion: factory/v2
name: my-repo # the repo's directory name
deploy:
  mode: make # `make deploy` releases it; the Watch runs `make verify`
  targets:
    - { name: mini, host: mini, verify: make verify } # host mini: hygiene judges the mini's run rules
  hold: 10m # the deploy finishes after the push; watch 10 minutes before done
ship:
  - { via: push }
signals:
  github: { author: jkrumm, since: 2026-11-17 } # the owner's new GitHub issues come in
```

`apiVersion` and `name` are the only required keys. Everything else has a default that is right for a repo that deploys
nothing and ships by push. Add a key when the repo differs, with the reason in a comment beside it: the comment is how
the next reader learns why the value is not the default.

## Check it before you push

- `factory project check [file]` checks a file offline (default `project.yaml`, `-` is stdin). An error names its line
  and column and exits 2; the factory would refuse that file and keep the last valid one. A warning exits 0 and names:
  a retired key, a `make <target>` the Makefile beside the file lacks, a `name` that is not the repo's directory, and a
  comment that cites a document that does not exist. Three more name what the file leaves unsaid or contradicts: a
  `doctor` target the Makefile defines but `doctor` does not name; a `verify` target the Makefile defines while the
  mode deploys and no `deploy.targets` entry says `verify: make verify`; `deploy.targets` listed under `deploy.mode:
  none` (the default), where nothing deploys and no target is ever verified; and a constant set without its reason
  (`leads` below the default, `slots.run`, `budgets.*`) that has no comment on its line, the line above or its
  parent key's line; and a `leads` below the default whose comment names a resource the factory already holds (a merge
  window or deploy queue, with a pointer to `factory merge-lock` or `deploy-lock`; disk) or says no reason was recorded.
- `factory project schema` prints this page offline; `--format json` adds the JSON Schema.
- `factory project check <file> --repo <dir>` judges a file that lives outside its repo (a host-local one) against that
  checkout's Makefile and directory name; without `--repo` the Makefile is looked for beside the file.
- `factory project sync --fetch true` reads the merged file now; `factory project show <repo>` prints what is in force,
  with `projectError` when the file on the default branch does not parse.

## A host-local file

A team repo whose colleagues review every PR should not carry factory config, and a gitignored file is invisible to the
factory (it reads the default branch). For such a repo the owner keeps the same file on the host instead:
`<projects dir>/<repo-directory-name>.yaml`, the directory being `FACTORY_PROJECTS_DIR` (default
`$HOME/.config/software-factory/projects`, `docs/settings.md`). Same schema, same checks (`factory project check <file>
--repo <repo checkout>`), same keys in force: `ship`, `leads`, `lanes`, `checks`, `doctor`, `deploy`.

- **Only for a repo with no committed `project.yaml`.** When both exist the committed file wins, and `factory project show`
  names the ignored local one in `projectWarnings`.
- **`source` is `local`** in `factory project show`. Edits are picked up by the next sync (the planning pass, or
  `factory project sync`); deleting the file puts the repo back on the defaults. A local file that does not parse keeps the last
  valid content and files the same broken-file Issue, naming the host-local file.
- **A local project is always a work project:** the read token never sees its words and it hears the owner only, whatever
  `work` says. It is the one class of repo the owner does not alone own, so the safe reading is fixed. The weekly hygiene
  sweep, the digests and the fix-cause reading, which read committed documents, skip it.
- **A lead never writes or commits it.** It is the owner's host file, outside every repo.

## The editor

The first line of the file names the schema; yaml-language-server (the YAML extension of VS Code, Zed, Neovim, the
JetBrains IDEs) then completes keys, shows each key's description and consumer on hover and marks a typo or a retired
key:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/jkrumm/software-factory/master/schema/project.schema.json
```

This repo points at its own copy instead, `# yaml-language-server: $schema=schema/project.schema.json`, so a schema
change is checked against the file in the same branch. Another repo adds the URL line above in its own change; the
factory never edits another repo's file. The server also serves the schema it parses with, `GET /v1/schema/project`
(`factory schema project`), for a tool that must match the running release rather than master.

## Choosing the values

- **`leads`**: leave it out. Unset is 64, no cap beyond the host's memory fit, load and the accounts, which already
  decide what runs (NL32). State a lower number only for a resource the repo cannot share and the factory does not
  model, with the measured number behind it. Not a reason: a merge window (`factory merge-lock` serialises it and a lead
  that waits holds no seat of its own), a deploy queue (`factory deploy-lock`), disk (admission fits the learned size of a
  worktree, build output included, against the free disk), "it is a small repo" (room left idle in the allowance costs more than a rebase).
  `factory project check` warns on those comments (a merge window only where a change lands by `ship: via: pr`) and on "no reason was recorded". A cap is re-checked against
  measurements: while it keeps Issues queued for an hour with account seats idle, the throughput loop files a signal on
  the repo naming it, its comment and the figures (NL48).
- **`lanes`**: for a kind of row that is heavier than the rest of the repo. `{apple: 1}` lets one Apple row run beside
  any number of others; `{round: {leads: 1, memory: 6GiB}}` also reserves 6 GiB on the host for each running lead of the
  lane. A row or Issue names its lane (`lane: apple`); an undeclared lane limits nothing. "Lanes" below has the rules.
- **`checks`**: when the full gate is too heavy for every lead to run locally. `{ fast: make check-fast, full: make
  check, ci: true }` has a lead run `fast` and rely on CI's run of `full` on the pull request head; `merge-guard` still
  demands that run green. Without `ci`, the lead runs `full` once before the first push. "Check tiers" below has the rules.
- **`env`**: switches the repo's own tools read in every lead's session (`env: { ORB_FORMAT: json }`), exported when the
  lead starts and again when a dormant one is resumed, so a change reaches leads started after the project syncs. Only
  what a CLI of the repo needs to behave for an agent; the file is public, so never a secret, and a name the factory or
  the host owns (`FACTORY_*`, `CLAUDE*`, `PATH`, `HOME`) is refused. A value is a quoted string: `1` and `true` are errors.
  A work repo's lead also gets `GH_CONFIG_DIR` from the host's `FACTORY_GH_CONFIG_DIR_WORK`, so `gh` and `factory land`
  run as the work account; a `GH_CONFIG_DIR` of the project's own `env` wins.
- **`steps`**: one entry per step the Makefile runs through `factory slot run --name "<project> <step>"`, keyed by
  `<step>`: `{ make: test, needs: [git], remote: true, carry: [packages/x/dist] }`. `remote: true` lets the factory run
  the step on its Linux step host when the mini's line would make it wait longer than that host takes, or when its learned
  run there is shorter than on the mini even with a mini slot free. Set it only for a
  step that passes in the step image: Ubuntu 24.04 with git, jq, make, shellcheck, the bun of `packageManager` and the PostgreSQL 16 server
  binaries (`initdb` and `pg_ctl` on `PATH`, `PG_BIN_DIR` set, so a step starts a private cluster in its container as it
  does on the mini; no cluster runs and no `needs` word is declared for it), the install with the network and the step
  without it. Green on `ubuntu-latest` is not that proof, because GitHub's image has Node, Chrome
  and a network. A step that needs more names its own `dockerfile` (built on the host, no build context). `needs` keeps
  a step home for `mac`, `apple`, `secrets` and `services`, and opens the network for `network`. `carry` is the build
  output the step reads that `.gitignore` leaves out. The step gets `FACTORY_STEP_CORES` and `FACTORY_STEP_MEM_MIB`, so
  it can size itself. A red on the step host is run again on the mini before anyone sees it; a green there keeps the
  step home for a hold of 1 hour that doubles with each repeat, up to 7 days. Which host it ran on, its wait and its cost are in Throughput's "Steps by host".
  `docs/architecture.md` "Steps off the mini".
- **`deploy.mode`** and **`hold`**: `make` when the lead's `make deploy` releases it and `make version` reads the live
  sha; `auto` when the push itself deploys (CI, Vercel, RollHook), so the Watch never asks for `make version`; `none`
  when nothing the factory can run deploys it. `hold` is how long the Watch keeps verifying before the Issue is done:
  `0m` for a synchronous `make deploy`, the length of the pipeline (`10m`) for an asynchronous one.
- **`ship`**: `- { via: pr }` for a repo whose changes land through a pull request; the Watch then expects CI on the
  head. One rule is enough: the factory reads only whether any rule says `pr`.
- **`hygiene`**: the weekly pass runs every built-in probe and the repo's `make check`. Switch one off only with a
  reason (`skip: [{ probe: browser, reason: … }]`, or `check: false` with `reason` when `make check` needs a lab this host
  lacks); add the repo's own read-only checks as `probes: [{ name, target }]`, each a Makefile target. The dependency
  refresh's bar and the days after which a repo is idle have defaults (`docs/hygiene.md`); `deps` and `idleAfterDays`
  change them for one repo, with a `reason`.
- **`doctor`**: `make doctor` when the repo needs something on the host (a toolchain, a simulator, a mounted volume)
  that can go missing. While it is red no lead of the repo is admitted, so it must be read-only and take seconds.
- **`signals`**: `github` brings the repo's GitHub issues in (the label, and every issue `author` opens after `since`),
  `github.checks` a red check run on the default branch, `launchd` a crashed LaunchAgent. Uptime Kuma and HyperDX alerts
  are routed by the door's registry (`factory door route-set`), not by this file.
- **`work: true`**: a repo of another organisation the factory builds in. The read token never sees its words, and it
  hears the owner only.

## Lanes

`leads: N` caps the leads in a repo; a repo that states none has no cap beyond the host (64, the bound), because memory fit,
load and the accounts already decide what runs. State `leads` only for a shared resource the repo's merge window or its
files cannot serve in parallel (one merge at a time, rebase conflicts on a ratchet file), with the reason in a comment
beside it (NL32). Work inside one repo is also not equally heavy: server rows are cheap, an Apple row
runs xcodebuild and a simulator on the one mini. Give each kind of row a `lane` and cap the heavy lane in the repo's
`project.yaml` (a lane's `leads`, like the repo's, is at most 64; a larger value is clamped, with a warning in `factory project show`):

```yaml
leads: 2
lanes:
  apple: 1
```

With that file, two rows in lane `apple` and one without a lane run as: one apple Issue and the lane-less Issue start
side by side, and the second apple Issue stays queued until the first closes. The queue order (`factory queue order`) and
`factory issue show` say so, the lane before the repo's claims: `lane apple is full (1 of 1): Issue 643`. `factory issue new --lane apple` sets the lane on a
hand-filed Issue; `factory project show` lists the project's `lanes` (leads and memory) and `factory issue show` the Issue's `lane`.

- **Scope is the repo.** A lane's cap counts the leads of that lane in the one repo whose `project.yaml` declares it. The
  host-wide Apple toolchain is already serialised by the shared Apple slot (`factory slot`); a lane keeps the second
  Apple lead from building cold in its own worktree while it queues for that slot. Another repo's Apple leads are not
  counted, so each repo states its own cap; a host-wide lane would couple one repo's file to another repo's admission.
- **A heavy lane reserves host memory.** `lanes: {apple: {leads: 1, memory: 18GiB}}` (`MiB` or `GiB`) makes every running
  lead of the lane count 18 GiB against the host's memory ceiling: admission adds the reserved share of RAM, for the
  running leads of every repo and for the candidate's own lane, to the swap share before it compares with the ceiling,
  and a refusal says so (`plus 36 GiB reserved by lanes (112.5% of RAM)`, kind `memory`). The gate only stops *new*
  leads, and a running lead's heavy step (a booted simulator, one run took about 18 GiB) shows in the reading only after
  it started, so the reservation covers the lead that has just been admitted. It is held for as long as the lead holds
  its claim, so it can count a step twice (reserved and already resident); that errs on the side of waiting. Without a
  RAM reading nothing is reserved and the pass notes it. A repo with three or more sampled attempts is admitted by what its leads were seen to take
  instead (`docs/architecture.md` "Capacity and leads"): the lane's `memory` is then dropped for it and stays the prior
  for a repo with fewer; the lane's `leads` cap stays.
- **An undeclared lane is unlimited** within `leads`. A row naming a lane the project does not declare is a plan
  **warning**, not a broken plan; the lane then limits nothing (a typo is visible in `factory project show`).
- **What counts as running:** a lead holding its claim, and a resumed lead working without one. A lead waiting on a
  Decision, a review, an Errand, a timer, a dependency or the owner's pause has given its claim back and its lane place with it, so another
  lead of the lane may start meanwhile; when the wait ends the lead takes its lane place back before it is told, and
  waits (like for a repo claim) while the lane is full.
- **A fix is never held by a lane** (an `incident` Issue has its own place beyond `leads`; production is red).
- A lane is a cap, not an order: it never replaces `after`, and a row that needs what another shipped still says `after`.
- The lane is fixed when the Issue is filed. An adopted row (`issue`) has no `lane`.

## Check tiers

The mini is the bottleneck for parallel leads and most of its load is checks: every lead ran the whole `make check`
locally, then `merge-guard` demanded the same suite green in CI on the exact head. `checks:` in `project.yaml` splits the
gate:

```yaml
checks: { fast: make check-fast, full: make check, ci: true }
```

- **`fast`** (required): what a lead runs locally before each push and after each change it authors (format, lint,
  types, scans, the unit tests of what the branch changed). **`full`** (default `make check`): the complete gate.
  **`ci: true`**: CI runs `full` on the pull request head, so the lead relies on that run; hosted runners for a public
  repo, `runs-on: [self-hosted, vps]` for a private one (never the self-hosted runner for a public repo), sharded with a
  matrix where the suite allows. Both commands are `make <target>`: the brief quotes them as data.
- **The brief** (`domains/leads/brief.ts`) gets a `## Checks in this repo` section for such a project: run `fast`
  where the standing orders say `make check`; with `ci: true` leave the full gate to CI (`merge-guard` still demands
  its green run on the exact head); rerun one heavy suite locally only to reproduce a CI failure, inside a slot. A
  project without `checks:` gets no section and keeps one `make check`.
- **Slots.** The slot name is the step (`software-factory check-fast` beside `software-factory check`), so the ledger
  learns the fast tier's peak apart from the whole gate's.
- **Test results.** `factory slot run` sets `FACTORY_JUNIT_DIR` (a fresh directory) for the command and posts the `*.xml` JUnit
  files left there beside the step's cost: that is how the flake rate and the failed-run minutes per project are measured
  (`factory read throughput`, `tests`). A repo's check targets write JUnit only when the variable is set, one file per
  runner, so CI and a bare local run write none: Bun `--reporter=junit --reporter-outfile=$FACTORY_JUNIT_DIR/<name>.xml`, Playwright
  the `junit` reporter with `outputFile` built from `process.env.FACTORY_JUNIT_DIR`, pytest `--junitxml=$FACTORY_JUNIT_DIR/<name>.xml`.
  Make expands the variable before the slot starts, so put the flags on a target that runs inside the `check` slot, or run it as
  `factory slot run -- make <target>`. Another project's Makefile is its own repo's to adopt.
- **Budgets.** `budgets: { fast: 90s, peak: 2GiB, fail: 10% }` (each key optional) bounds what a project's checks may cost: `fast` the median of a day's fast-tier runs, `peak` the largest peak memory of one step, `fail` the share of a day's steps that exited non-zero (a red `check-fast` left out; over on two days in a row). A breach is a signal on the project's repo the day it happens and again only after the figure was back inside (`docs/architecture.md`, `selfwatch`); `peak` is also the target of the throughput loop's memory finding.
- `factory project show` prints `checks` (`null` for none). Another project's `checks:` is its own repo's to adopt: the
  Makefile target and the CI workflow it names are that repo's.

## Retired keys

A retired key is accepted and dropped, so a file written before it was retired still parses, and `factory project
check` warns on it. These were parsed and read by nothing, checked on 2026-11-17 against the server, the CLI, the
contract, the Console and the probes that read the raw file (`deploy.targets[].host` stays: the `runrules` probe reads it):

- **`deploy.migrations`**: no gate or brief ever used it. Where a repo's migrations live and how they run belongs in its
  `AGENTS.md`, which its lead reads first.
- **`ship[].paths`**: no code ever matched a change against the globs; only `via` is read.
- **`signals.kuma`**, **`signals.hyperdx`**: removed, not retired (no repo set them, and a typo under `signals` is now an
  error). The door's registry routes those alerts.
- **`jobs`**, **`ticktick`**: keys of the old core.

## Key reference

Type `duration` is `30s`, `30m`, `2h` or `1d`; `size` is `512MiB` or `18GiB`; `share` is `10%`. A path with `[]` is a
list's entry, `<name>` a map's key.

<!-- keys:start (generated by scripts/project-schema.ts; edit the schema, then `bun scripts/project-schema.ts`) -->

| Key | Type | Default | What it means |
|-|-|-|-|
| `apiVersion` | `factory/v2` | required | the file format; `factory/v2`, any other is a broken file |
| `name` | string | required | the repo's directory name; a file whose name is not its directory's is refused |
| `host` | string | — | the host the repo's alerts sit on, a key of config/infra.json's hosts (`macmini`), so its Kuma and HyperDX alerts join that host's incident |
| `deploy` | object | `{}` | how a shipped change is deployed and watched |
| `deploy.mode` | `auto`, `make`, `agentic`, `none` | `"none"` | how a shipped change reaches production. `auto`: a push to the default branch deploys (CI, Vercel, RollHook), the Watch asks no `make version`; `make`: the lead runs `make deploy` and `make version` reads the live sha; `agentic`: the lead deploys by its own steps; `none`: nothing deploys, done is merged with CI green |
| `deploy.targets` | list of object | `[]` | where a deploy is verified, one entry per place. Empty: the Watch runs `make verify` when the Makefile has it. Listing `make <target>` alone runs that target instead: the way for a repo whose `verify` also reads state it does not own (another target's deploy gate) to be judged on its own |
| `deploy.targets[].name` | string | required | the target's name, shown on the project page (`mini`, `prod`) |
| `deploy.targets[].host` | string | — | the machine the target runs on (`mini`, `vps`, `homelab`). `mini` makes the weekly hygiene pass judge the repo against the run rules for the mini (`runrules`), which it otherwise does only for a repo with a root `mini-services.yaml` |
| `deploy.targets[].verify` | string | required | how a deploy is proved: `make verify` (or another `make <target>`) run in the repo, or an http(s) URL the Watch GETs and expects 200 from |
| `deploy.hold` | duration | `"0m"` | how long a shipped change is watched before it counts as done (`30m`, `2h`, `1d`, at most 7d). Give an asynchronous deploy (CI, a rolling swap) its time here |
| `deploy.paths` | list of string | `[]` | globs of the paths a deploy carries (`apps/**`, `Makefile`). Empty: every path that is not inert deploys. Set: a ship touching none of them records no deploy and no deployed-version check, as a rewrite built beside the running system must |
| `deploy.probes` | list of object | `[]` | HTTP probes the Watch runs after every deploy, beside the targets |
| `deploy.probes[].name` | string | required | the probe's name in the Watch's evidence |
| `deploy.probes[].http` | string | required | the URL the Watch GETs |
| `deploy.probes[].expect` | integer 100–599 | `200` | the HTTP status the probe expects |
| `ship` | list of object | `[{"via":"push"}]` | how a change lands: a list of `{ via }` rules; any `via: pr` makes the Watch expect CI |
| `ship[].via` | `push`, `pr` | required | `pr`: changes land through a pull request, so the Watch expects CI on the head; `push`: straight to the default branch |
| `work` | boolean | `false` | `true`: the repo stays a work repo though it has a project.yaml: the read token never sees its words and it hears the owner only. For a repo of another organisation the factory builds in |
| `leads` | integer 1–64 | `64` | how many leads may work in the repo at once (one more for a fix while the line is stopped). Unset: 64, no cap beyond the host's memory, load and accounts; a value above 64 is clamped with a warning. A lower cap is an exception the file gives its reason for (NL32) |
| `lanes` | map of integer 1–64 or object | `{}` | resources inside the repo: `{apple: 1}` lets one lead of lane apple run at once; `{apple: {leads: 1, memory: 18GiB}}` also reserves that memory on the host for every running lead of the lane. A lane a row or Issue names and this does not declare is unlimited within `leads` |
| `lanes.<name>.leads` | integer 1–64 | required | how many leads of the lane run at once |
| `lanes.<name>.memory` | size | — | the host memory each running lead of the lane reserves (`18GiB`, at most 1 TiB) |
| `env` | map of string | `{}` | variables exported into every lead's session in this repo (`ORB_FORMAT: json`), at start and when a dormant lead is resumed; values are strings of one line, at most 500 characters, and this file is public: never a secret. A name the factory or the host owns (`FACTORY_*`, `CLAUDE*`, `ANTHROPIC_*`, `USAGE_*`, `PATH`, `HOME`, ...) is refused |
| `slots` | object | `{}` | the repo's test-slot limits |
| `slots.run` | duration | — | how long one `factory slot run` of this repo may hold a test slot before it is stopped (at least 1m, at most 6h; unset: 30m) |
| `steps` | map of object | `{}` | the repo's named steps (`unit`, `layout`): the Makefile target, what each needs and where the factory may run it. A step not named runs on the mini |
| `steps.<name>.make` | string | — | the Makefile target that runs the step (`test`); `factory project check` warns when it is missing |
| `steps.<name>.needs` | list of `linux`, `mac`, `browser`, `apple`, `secrets`, `services`, `git`, `network` | `[]` | `linux`, `mac`, `browser`, `apple`, `secrets`, `services`, `git`, `network`: what the step needs of its host. `mac`, `apple`, `secrets` and `services` keep it on the mini |
| `steps.<name>.remote` | boolean | `false` | `true`: the factory may run the step off the mini, on a Linux step host of its own settings, when that finishes it sooner. The repo's word that the step passes on Ubuntu 24.04 in the step image; the owner still admits the project (`FACTORY_STEP_REMOTE_PROJECTS`), and a step red there but green on the mini loses its place off the mini for a hold that starts at 1 hour and doubles with each repeat, up to 7 days |
| `steps.<name>.dockerfile` | string | — | the repo's own image for the step off the mini (a Dockerfile in the repo, built on the step host once per content); unset: the factory's (Ubuntu 24.04, git, jq, make, shellcheck, bun and the PostgreSQL server binaries). Required for `needs: [browser]` off the mini |
| `steps.<name>.bun` | string | — | the bun of the step image; unset: the version of the repo's `packageManager` (`bun@1.4.3` in package.json) |
| `steps.<name>.carry` | list of string | `[]` | git-ignored paths the step reads (build output such as `packages/x/dist`): they travel with the tracked and untracked files |
| `budgets` | object | `{}` | what the repo's checks may cost; a day over one is a signal on the repo. A key left out is no budget |
| `budgets.fast` | duration | — | the most the median of a day's fast-tier check runs may take (`5m`) |
| `budgets.peak` | size | — | the most peak memory one check step may take (`4GiB`) |
| `budgets.fail` | share | — | the most of a day's check steps that may exit non-zero (`30%`); a red `check-fast` is not counted, and a breach needs the share on two days in a row |
| `checks` | object or null | `null` | check tiers: a fast local check and the full gate (CI's when `ci` is true). Unset: the lead runs `make check` |
| `checks.fast` | string | required | what a lead runs locally before each push (`make check-fast`) |
| `checks.full` | string | `"make check"` | the complete gate |
| `checks.ci` | boolean | `false` | `true`: CI runs `full` on the pull request head, so the lead runs only `fast` and relies on that run (`make merge-guard` still demands it green) |
| `doctor` | string or null | `null` | `make doctor`: a read-only command of seconds that exits 0 when this host can run the project, else non-zero with one line per missing prerequisite and its fix. Red keeps every lead of the repo from being admitted and the hygiene `check` probe from running |
| `hygiene` | object | `{"check":true,"skip":[],"probes":[]}` | what the weekly hygiene pass runs on the repo |
| `hygiene.check` | boolean | `true` | `false`: the repo's `make check` needs a lab the factory host does not have, so the weekly pass skips its `check` probe (with `reason`) |
| `hygiene.reason` | string | — | why `check` is false, or why `idleAfterDays` or `deps` depart from the defaults; required then |
| `hygiene.idleAfterDays` | integer 0–3650 | — | days without a commit on the default branch after which the repo is idle: its `deps` refresh and document judgment run monthly instead of weekly (default 30); 0 is never idle; needs `reason` |
| `hygiene.deps` | object | — | the bar the `deps` refresh must clear before it is filed; a key left out keeps its default |
| `hygiene.deps.runtimeStaleDays` | integer 1–365 | — | a runtime dependency a minor or more behind whose latest version is at least this many days old files the `deps` refresh (default 30); needs `reason` |
| `hygiene.deps.behindRows` | integer 1–1000 | — | this many dependencies behind in all (after their cooldown, patches and dev tools included) file the `deps` refresh (default 10); needs `reason` |
| `hygiene.skip` | list of object | `[]` | built-in probes the repo opts out of, each with its reason (advisories, links, retired, project, deps, ci, agentsmd, readme, stale, deadcode, runrules, browser, context) |
| `hygiene.skip[].probe` | `advisories`, `links`, `retired`, `project`, `deps`, `ci`, `agentsmd`, `readme`, `stale`, `deadcode`, `runrules`, `browser`, `context` | required | the built-in probe switched off |
| `hygiene.skip[].reason` | string | required | why: a probe is never switched off without one; the pass shows it |
| `hygiene.probes` | list of object | `[]` | the repo's own weekly probes, at most 16 |
| `hygiene.probes[].name` | string | required | the probe's name; a finding is keyed `probe:<name>` |
| `hygiene.probes[].target` | string | required | the Makefile target the loop runs as `make <target>` in a throwaway checkout; any exit but 0 is a finding |
| `signals` | object | `{}` | which automatic sources the repo listens to; a work repo lists none and hears the owner only |
| `signals.github` | object | — | the repo's GitHub issues and check runs come in as signals |
| `signals.github.label` | string | `"factory"` | a GitHub issue with this label is filed as a signal, whoever opened it |
| `signals.github.checks` | boolean | `false` | `true`: a red check run on the default branch is filed as a signal |
| `signals.github.author` | string | — | every new issue this login opens is filed without the label; set together with `since` |
| `signals.github.since` | string | — | issues of `author` opened before this are never filed; set together with `author` |
| `signals.launchd` | list of string | — | LaunchAgent labels on the mini whose crash or failed exit is filed as a signal on this repo |
| `heal` | list of object | `[]` | alerts that wait for their own recovery before they are filed |
| `heal[].when` | string | required | `<source>.down`: the alert this rule settles |
| `heal[].grace` | duration | required | how long the `down` waits for its `up` before it is filed (at most 1d) |
| `heal[].runbook` | `make restart` | — | run first, before the grace starts |
| `heal[].max` | integer 1–5 | `1` | how many heals in a row before it is filed anyway |

Retired keys: accepted and dropped so an older file still parses, read by nothing; `factory project check` warns on each.

| Key | Type | Default | What it means |
|-|-|-|-|
| `deploy.migrations` | list of string | — | Retired: read by nothing; no gate or brief ever used it. Where migrations live and how they run belongs in the repo's AGENTS.md. Remove it. |
| `ship[].paths` | list of string | — | Retired: read by nothing; no code ever matched a change against these globs. The factory reads only whether any rule ships `via: pr`. Remove it. |
| `policy` | any | — | Retired: a Decision goes to the Judge, then its default, then the owner. Accepted and dropped. Remove it. |
| `jobs` | any | — | Retired with the old core; accepted and dropped. Remove it. |
| `ticktick` | any | — | Retired with the old core; accepted and dropped. Remove it. |

<!-- keys:end -->
