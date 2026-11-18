# project.yaml

A repo tells the factory how it ships in one file at its root, `project.yaml`. The factory reads it from the default
branch, so a change counts once it is merged. Every key is typed: the schema lives in
`packages/contract/src/project-file.ts`, and the JSON Schema, the editor hover and the key reference at the end of this page
are generated from it. A repo without the file is a work repo: no deploy, ship by push, no cap on leads, and it hears the
owner only.

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
  parent key's line.
- `factory project schema` prints this page offline; `--format json` adds the JSON Schema.
- `factory project sync --fetch true` reads the merged file now; `factory project show <repo>` prints what is in force,
  with `projectError` when the file on the default branch does not parse.

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
  decide what runs (NL32). State a lower number only for a resource the repo cannot share, with the number behind it:
  software-factory caps at 12 because its merge window serialises about ten merges an hour and a lead at 12 waits
  ~1.2 h of the lock's 90 minutes. "It is a small repo" is no reason; an idle seat costs more than a rebase.
- **`lanes`**: for a kind of row that is heavier than the rest of the repo. `{apple: 1}` lets one Apple row run beside
  any number of others; `{round: {leads: 1, memory: 6GiB}}` also reserves 6 GiB on the host for each running lead of the
  lane. A row or Issue names its lane (`lane: apple`); an undeclared lane limits nothing. `docs/plan.md` "Lanes".
- **`checks`**: when the full gate is too heavy for every lead to run locally. `{ fast: make check-fast, full: make
  check, ci: true }` has a lead run `fast` and rely on CI's run of `full` on the pull request head; `merge-guard` still
  demands that run green. Without `ci`, the lead runs `full` once before the first push. `docs/plan.md` "Check tiers".
- **`env`**: switches the repo's own tools read in every lead's session (`env: { ORB_FORMAT: json }`), exported when the
  lead starts and again when a dormant one is resumed, so a change reaches leads started after the project syncs. Only
  what a CLI of the repo needs to behave for an agent; the file is public, so never a secret, and a name the factory or
  the host owns (`FACTORY_*`, `CLAUDE*`, `PATH`, `HOME`) is refused. A value is a quoted string: `1` and `true` are errors.
- **`steps`**: one entry per step the Makefile runs through `factory slot run --name "<project> <step>"`, keyed by
  `<step>`: `{ make: test, needs: [git], remote: true, carry: [packages/x/dist] }`. `remote: true` lets the factory run
  the step on its Linux step host when the mini's line would make it wait longer than that host takes. Set it only for a
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
  lacks); add the repo's own read-only checks as `probes: [{ name, target }]`, each a Makefile target.
- **`doctor`**: `make doctor` when the repo needs something on the host (a toolchain, a simulator, a mounted volume)
  that can go missing. While it is red no lead of the repo is admitted, so it must be read-only and take seconds.
- **`signals`**: `github` brings the repo's GitHub issues in (the label, and every issue `author` opens after `since`),
  `github.checks` a red check run on the default branch, `launchd` a crashed LaunchAgent. Uptime Kuma and HyperDX alerts
  are routed by the door's registry (`factory door route-set`), not by this file.
- **`work: true`**: a repo of another organisation the factory builds in. The read token never sees its words, and it
  hears the owner only.

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

| Key | Type | Default | Read by | What it means |
|-|-|-|-|-|
| `apiVersion` | `factory/v2` | required | sync (apps/server/src/domains/planning/sync.ts) | the file format; `factory/v2`, any other is a broken file |
| `name` | string | required | sync (apps/server/src/domains/planning/sync.ts) | the repo's directory name; a file whose name is not its directory's is refused |
| `host` | string | — | intake (apps/server/src/domains/planning/signals.ts) | the host the repo's alerts sit on, a key of config/infra.json's hosts (`macmini`), so its Kuma and HyperDX alerts join that host's incident |
| `deploy` | object | `{}` | the Watch (apps/server/src/app/quality-projects.ts) | how a shipped change is deployed and watched |
| `deploy.mode` | `auto`, `make`, `agentic`, `none` | `"none"` | the Watch (apps/server/src/app/quality-projects.ts) | how a shipped change reaches production. `auto`: a push to the default branch deploys (CI, Vercel, RollHook), the Watch asks no `make version`; `make`: the lead runs `make deploy` and `make version` reads the live sha; `agentic`: the lead deploys by its own steps; `none`: nothing deploys, done is merged with CI green |
| `deploy.targets` | list of object | `[]` | the Watch (apps/server/src/app/quality-projects.ts) | where a deploy is verified, one entry per place. Empty: the Watch runs `make verify` when the Makefile has it |
| `deploy.targets[].name` | string | required | the Watch (apps/server/src/app/quality-projects.ts) | the target's name, shown on the project page (`mini`, `prod`) |
| `deploy.targets[].host` | string | — | the hygiene runrules probe (apps/server/src/adapters/hygiene/probes/runrules.ts, read from the raw file) | the machine the target runs on (`mini`, `vps`, `homelab`). `mini` makes the weekly hygiene pass judge the repo against the run rules for the mini (`runrules`), which it otherwise does only for a repo with a root `mini-services.yaml` |
| `deploy.targets[].verify` | string | required | the Watch (apps/server/src/app/quality-projects.ts) | how a deploy is proved: `make verify` (or another `make <target>`) run in the repo, or an http(s) URL the Watch GETs and expects 200 from |
| `deploy.hold` | duration | `"0m"` | the Watch (apps/server/src/app/quality-projects.ts) | how long a shipped change is watched before it counts as done (`30m`, `2h`, `1d`, at most 7d). Give an asynchronous deploy (CI, a rolling swap) its time here |
| `deploy.paths` | list of string | `[]` | the ship gate (apps/server/src/domains/quality/gate.ts) and the Watch | globs of the paths a deploy carries (`apps/**`, `Makefile`). Empty: every path that is not inert deploys. Set: a ship touching none of them records no deploy and no deployed-version check, as a rewrite built beside the running system must |
| `deploy.probes` | list of object | `[]` | the Watch (apps/server/src/app/quality-projects.ts) | HTTP probes the Watch runs after every deploy, beside the targets |
| `deploy.probes[].name` | string | required | the Watch (apps/server/src/app/quality-projects.ts) | the probe's name in the Watch's evidence |
| `deploy.probes[].http` | string | required | the Watch (apps/server/src/app/quality-projects.ts) | the URL the Watch GETs |
| `deploy.probes[].expect` | integer 100–599 | `200` | the Watch (apps/server/src/app/quality-projects.ts) | the HTTP status the probe expects |
| `ship` | list of object | `[{"via":"push"}]` | the Watch (apps/server/src/app/quality-projects.ts) | how a change lands: a list of `{ via }` rules; any `via: pr` makes the Watch expect CI |
| `ship[].via` | `push`, `pr` | required | the Watch (apps/server/src/app/quality-projects.ts) | `pr`: changes land through a pull request, so the Watch expects CI on the head; `push`: straight to the default branch |
| `work` | boolean | `false` | read redaction and intake (apps/server/src/domains/planning/signals.ts, apps/server/src/api/planning.ts) | `true`: the repo stays a work repo though it has a project.yaml: the read token never sees its words and it hears the owner only. For a repo of another organisation the factory builds in |
| `leads` | integer 1–64 | `64` | admission (apps/server/src/app/capacity-admit.ts) | how many leads may work in the repo at once (one more for a fix while the line is stopped). Unset: 64, no cap beyond the host's memory, load and accounts; a value above 64 is clamped with a warning. A lower cap is an exception the file gives its reason for (NL32) |
| `lanes` | map of integer 1–64 or object | `{}` | admission (apps/server/src/app/capacity-admit.ts) | resource classes inside the repo: `{apple: 1}` lets one lead of lane apple run at once; `{apple: {leads: 1, memory: 18GiB}}` also reserves that memory on the host for every running lead of the lane. A lane a row or Issue names and this does not declare is unlimited within `leads` |
| `lanes.<name>.leads` | integer 1–64 | required | admission (apps/server/src/app/capacity-admit.ts) | how many leads of the lane run at once |
| `lanes.<name>.memory` | size | — | admission (apps/server/src/app/capacity-admit.ts) | the host memory each running lead of the lane reserves (`18GiB`, at most 1 TiB) |
| `env` | map of string | `{}` | the lead's start (apps/server/src/app/leads-start.ts, apps/server/src/adapters/hc/terminals.ts) | variables exported into every lead's session in this repo (`ORB_FORMAT: json`), at start and when a dormant lead is resumed; values are strings of one line, at most 500 characters, and this file is public: never a secret. A name the factory or the host owns (`FACTORY_*`, `CLAUDE*`, `ANTHROPIC_*`, `USAGE_*`, `PATH`, `HOME`, ...) is refused |
| `slots` | object | `{}` | test slots (apps/server/src/app/capacity-slots.ts) | the repo's test-slot limits |
| `slots.run` | duration | — | test slots (apps/server/src/app/capacity-slots.ts) | how long one `factory slot run` of this repo may hold a test slot before it is stopped (at least 1m, at most 6h; unset: 30m) |
| `steps` | map of object | `{}` | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | the repo's named steps (`unit`, `layout`): the Makefile target, what each needs and where the factory may run it. A step not named runs on the mini |
| `steps.<name>.make` | string | — | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | the Makefile target that runs the step (`test`); `factory project check` warns when it is missing |
| `steps.<name>.needs` | list of `linux`, `mac`, `browser`, `apple`, `secrets`, `services`, `git`, `network` | `[]` | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | `linux`, `mac`, `browser`, `apple`, `secrets`, `services`, `git`, `network`: what the step needs of its host. `mac`, `apple`, `secrets` and `services` keep it on the mini |
| `steps.<name>.remote` | boolean | `false` | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | `true`: the factory may run the step off the mini, on a Linux step host of its own settings, when that finishes it sooner. The repo's word that the step passes on Ubuntu 24.04 in the step image; the owner still admits the project (`FACTORY_STEP_REMOTE_PROJECTS`), and a step red there but green on the mini loses its place off the mini for a hold that starts at 1 hour and doubles with each repeat, up to 7 days |
| `steps.<name>.dockerfile` | string | — | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | the repo's own image for the step off the mini (a Dockerfile in the repo, built on the step host once per content); unset: the factory's (Ubuntu 24.04, git, jq, make, shellcheck, bun and the PostgreSQL server binaries). Required for `needs: [browser]` off the mini |
| `steps.<name>.bun` | string | — | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | the bun of the step image; unset: the version of the repo's `packageManager` (`bun@1.4.3` in package.json) |
| `steps.<name>.carry` | list of string | `[]` | step placement (apps/server/src/app/capacity-slots.ts, apps/cli/src/remote-step.ts) | git-ignored paths the step reads (build output such as `packages/x/dist`): they travel with the tracked and untracked files |
| `budgets` | object | `{}` | the throughput loop (apps/server/src/app/loops/throughput.ts) | what the repo's checks may cost; a day over one is a signal on the repo. A key left out is no budget |
| `budgets.fast` | duration | — | the throughput loop (apps/server/src/app/loops/throughput.ts) | the most the median of a day's fast-tier check runs may take (`5m`) |
| `budgets.peak` | size | — | the throughput loop (apps/server/src/app/loops/throughput.ts) | the most peak memory one check step may take (`4GiB`) |
| `budgets.fail` | share | — | the throughput loop (apps/server/src/app/loops/throughput.ts) | the most of a day's check steps that may exit non-zero (`30%`) |
| `checks` | object or null | `null` | the lead's brief (apps/server/src/domains/leads/brief.ts) | check tiers: a fast local check and the full gate (CI's when `ci` is true). Unset: the lead runs `make check` |
| `checks.fast` | string | required | the lead's brief (apps/server/src/domains/leads/brief.ts) | what a lead runs locally before each push (`make check-fast`) |
| `checks.full` | string | `"make check"` | the lead's brief (apps/server/src/domains/leads/brief.ts) | the complete gate |
| `checks.ci` | boolean | `false` | the lead's brief (apps/server/src/domains/leads/brief.ts) | `true`: CI runs `full` on the pull request head, so the lead runs only `fast` and relies on that run (`make merge-guard` still demands it green) |
| `doctor` | string or null | `null` | admission (apps/server/src/app/capacity-admit.ts) and the hygiene loop (apps/server/src/app/loops/hygiene.ts) | `make doctor`: a read-only command of seconds that exits 0 when this host can run the project, else non-zero with one line per missing prerequisite and its fix. Red keeps every lead of the repo from being admitted and the hygiene `check` probe from running |
| `hygiene` | object | `{"check":true,"skip":[],"probes":[]}` | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | what the weekly hygiene pass runs on the repo |
| `hygiene.check` | boolean | `true` | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | `false`: the repo's `make check` needs a lab the factory host does not have, so the weekly pass skips its `check` probe (with `reason`) |
| `hygiene.reason` | string | — | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | why `check` is false; required then |
| `hygiene.skip` | list of object | `[]` | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | built-in probes the repo opts out of, each with its reason (advisories, links, retired, project, deps, ci, agentsmd, readme, stale, deadcode, cochange, runrules, browser, context) |
| `hygiene.skip[].probe` | `advisories`, `links`, `retired`, `project`, `deps`, `ci`, `agentsmd`, `readme`, `stale`, `deadcode`, `cochange`, `runrules`, `browser`, `context` | required | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | the built-in probe switched off |
| `hygiene.skip[].reason` | string | required | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | why: a probe is never switched off without one; the pass shows it |
| `hygiene.probes` | list of object | `[]` | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | the repo's own weekly probes, at most 16 |
| `hygiene.probes[].name` | string | required | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | the probe's name; a finding is keyed `probe:<name>` |
| `hygiene.probes[].target` | string | required | the hygiene loop (apps/server/src/app/loops/hygiene.ts) | the Makefile target the loop runs as `make <target>` in a throwaway checkout; any exit but 0 is a finding |
| `signals` | object | `{}` | intake (apps/server/src/domains/planning/signals.ts) | which automatic sources the repo listens to; a work repo lists none and hears the owner only |
| `signals.github` | object | — | intake (apps/server/src/domains/planning/signals.ts) | the repo's GitHub issues and check runs come in as signals |
| `signals.github.label` | string | `"factory"` | intake (apps/server/src/domains/planning/signals.ts) | a GitHub issue with this label is filed as a signal, whoever opened it |
| `signals.github.checks` | boolean | `false` | intake (apps/server/src/domains/planning/signals.ts) | `true`: a red check run on the default branch is filed as a signal |
| `signals.github.author` | string | — | intake (apps/server/src/domains/planning/signals.ts) | every new issue this login opens is filed without the label; set together with `since` |
| `signals.github.since` | string | — | intake (apps/server/src/domains/planning/signals.ts) | issues of `author` opened before this are never filed; set together with `author` |
| `signals.launchd` | list of string | — | launchd intake (apps/server/src/adapters/intake/launchd.ts) | LaunchAgent labels on the mini whose crash or failed exit is filed as a signal on this repo |
| `heal` | list of object | `[]` | intake (apps/server/src/app/intake.ts) | alerts that wait for their own recovery before they are filed |
| `heal[].when` | string | required | intake (apps/server/src/app/intake.ts) | `<source>.down`: the alert this rule settles |
| `heal[].grace` | duration | required | intake (apps/server/src/app/intake.ts) | how long the `down` waits for its `up` before it is filed (at most 1d) |
| `heal[].runbook` | `make restart` | — | intake (apps/server/src/app/intake.ts) | run first, before the grace starts |
| `heal[].max` | integer 1–5 | `1` | intake (apps/server/src/app/intake.ts) | how many heals in a row before it is filed anyway |
| `policy` | list of object | `[]` | Decision policies (apps/server/src/app/planning-policies.ts) | standing answers: the first rule whose phrase the question contains and whose answer is one of its options settles a Decision |
| `policy[].when` | string | required | Decision policies (apps/server/src/app/planning-policies.ts) | a phrase the Decision's question contains |
| `policy[].answer` | string | required | Decision policies (apps/server/src/app/planning-policies.ts) | the option label the rule takes; it must be one of the options |
| `policy[].reason` | string | required | Decision policies (apps/server/src/app/planning-policies.ts) | why, recorded with the answer |

Retired keys: accepted and dropped so an older file still parses, read by nothing; `factory project check` warns on each.

| Key | Type | Default | Read by | What it means |
|-|-|-|-|-|
| `deploy.migrations` | list of string | — | nothing (retired) | Retired: read by nothing; no gate or brief ever used it. Where migrations live and how they run belongs in the repo's AGENTS.md. Remove it. |
| `ship[].paths` | list of string | — | nothing (retired) | Retired: read by nothing; no code ever matched a change against these globs. The factory reads only whether any rule ships `via: pr`. Remove it. |
| `jobs` | any | — | nothing (retired) | Retired with the old core; accepted and dropped. Remove it. |
| `ticktick` | any | — | nothing (retired) | Retired with the old core; accepted and dropped. Remove it. |

<!-- keys:end -->
