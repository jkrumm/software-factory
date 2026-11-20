import * as z from 'zod'

/**
 * The hygiene catalogue: every probe the weekly and daily passes can run, what it checks, whether it is on, when and at what
 * cost, and how a project silences it. The one source for `docs/hygiene.md` (generated; `make check` fails when it is stale),
 * the project page's Hygiene tab and `factory read project-hygiene`; the server's probe order, the cadence of a pass, the keys `hygiene.skip` accepts are all read from here.
 */

/** `on`: every project; `auto`: on when detection finds what it reads; `opt-in`: only where the project declares it. */
export const PROBE_ENABLEMENTS = ['on', 'auto', 'opt-in'] as const
/** `file`: reads tracked files; `tool`: runs an analyzer or asks the network; `make`: runs the project's own make target; `agent`: one model call on the cheap seat. */
export const PROBE_COSTS = ['file', 'tool', 'make', 'agent'] as const
/** `daily`: a pass of the cheap probes every day; `weekly`: only the weekly pass (and a busy repo's early one). */
export const PROBE_CADENCES = ['daily', 'weekly'] as const

export const HygieneCatalogueEntry = z
  .strictObject({
    /** the probe's name; a declared probe is `probe` */
    name: z.string(),
    /** one sentence: what it checks */
    summary: z.string(),
    enabled: z.enum(PROBE_ENABLEMENTS),
    /** for `auto`: what turns it on; for `opt-in` how the project asks; null for `on` */
    detect: z.string().nullable(),
    cost: z.enum(PROBE_COSTS),
    cadence: z.enum(PROBE_CADENCES),
    /** whether `hygiene.skip` may name it; the others are silenced the way `silence` says */
    skippable: z.boolean(),
    /** how a project silences it, always with a reason */
    silence: z.string(),
    /** on a repo with no commit for `HYGIENE_DEFAULTS.idleAfterDays`: `monthly` runs it in the monthly pass only; absent, as often as `cadence` */
    idle: z.literal('monthly').optional(),
    /**
     * The deterministic fix the pass runs before it files (absent: none). `keys` are the finding keys it covers, `does` what
     * the script does, `lands` where its result goes. The probe, run again, is the proof; a failed fix files the finding with
     * the script's output attached.
     */
    fix: z
      .strictObject({ keys: z.array(z.string()).min(1).readonly(), does: z.string(), lands: z.string() })
      .optional(),
  })
  .meta({ id: 'HygieneCatalogueEntry' })
export type HygieneCatalogueEntry = z.infer<typeof HygieneCatalogueEntry>

/**
 * The numbers the hygiene loop decides by, one place: a project overrides them under `hygiene` in `project.yaml`, with its reason.
 * `idleAfterDays`: a repo whose default branch has no commit for this long is idle, and its `idle: 'monthly'` probes (and the
 * document judgment) run every `monthlyDays`; 0 in a project is never idle. `deps`: the bar a dependency refresh must clear
 * before it is filed (`runtimeStaleDays`: a runtime dependency a minor or more behind whose latest is this old; `behindRows`:
 * rows behind in all, after the cooldown). Measured on the 60 readings of 2026-11-08 to 11-18: 22 filed, flat from 8 to 15 rows
 * and from 14 to 60 days (`docs/decisions.md`).
 */
export const HYGIENE_DEFAULTS = {
  idleAfterDays: 30,
  monthlyDays: 30,
  deps: { runtimeStaleDays: 30, behindRows: 10 },
} as const

export interface DepsThresholds {
  runtimeStaleDays: number
  behindRows: number
}

const SKIP = 'Name it under `hygiene.skip` in `project.yaml` with a reason; the pass shows the reason.'

/** In the order the probes file their findings when the pass budget is short (the server's `PROBES` is this list's names). */
export const HYGIENE_CATALOGUE = [
  {
    name: 'check',
    summary:
      "`make check` on the default branch in a throwaway checkout, inside a test slot; red is one finding with the tail of the output, confirmed in the project's own checkout when that is clean at the same commit. A project whose `signals.github.checks` is on has its red default branch filed by the intake and skips this probe, so the one fact has one detector.",
    enabled: 'on',
    detect: null,
    cost: 'make',
    cadence: 'weekly',
    skippable: false,
    silence:
      'Set `hygiene: { check: false, reason: <why> }` when the gate needs a lab this host lacks; a red `doctor` skips it on its own.',
  },
  {
    name: 'advisories',
    summary:
      'Known security advisories of severity high and up in the lockfiles: `bun audit` for a `bun.lock`, `osv-scanner` for `Cargo.lock`, `uv.lock`, `requirements*.txt` and `Package.resolved`. An advisory with a fixed version files the `deps` refresh; one with none is listed on the tab and read again every pass, never filed.',
    enabled: 'auto',
    detect:
      'a lockfile of one of those kinds is tracked; the Cargo, Python and Swift ones are skipped on a host without `osv-scanner`',
    cost: 'tool',
    cadence: 'weekly',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'links',
    summary: 'Relative links in the living Markdown documents that point at a file that does not exist.',
    enabled: 'on',
    detect: null,
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'retired',
    summary:
      "The repo's own retired-words check (`scripts/retired-words.ts`) over the living documents `make check` does not scan.",
    enabled: 'auto',
    detect: 'the repo has `scripts/retired-words.ts`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'project',
    summary:
      'The `project.yaml` itself, linted like `factory project check`: keys nothing reads, a `make` target the Makefile lacks, a header that cites a missing document, a `doctor` or `verify` target the Makefile has but the file does not name, deploy targets with mode `none`, constants without a stated reason.',
    enabled: 'auto',
    detect: 'the repo has a `project.yaml`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'deps',
    fix: {
      keys: ['deps'],
      does: "For `bun`: each patch or minor past its cooldown that the root `package.json` declares is set with `bun add <name>@<version>` (an exact pin stays exact), then the repo's check runs in a test slot.",
      lands:
        "On green, a `chore(deps)` commit: pushed to the default branch of a repo that ships by push, or, for one that ships by pull request, opened as a pull request inside the repo's merge window, merged once its CI and the merge guard are green (a red CI closes it). Neither deploys: the next ship of the repo does. A red check, a major, a held version, a workspace package and every other ecosystem go to a lead; the check's output is on the Issue.",
    },
    summary:
      'Outdated dependencies and the advisories above, as one refresh per repo: `bun outdated` for a `package.json`, and the versions pinned in `Cargo.toml`, `pyproject.toml` or `requirements*.txt`, `Package.swift`, Dockerfile base images and GitHub Actions `uses:` lines. One finding `deps` is filed only when the refresh clears the bar (below); it carries a section and an upgrade plan per ecosystem (versions younger than 7 days, 14 for a major, held back; patches and minors, packages that move together, and each major in batches) and the procedure a light lead follows. Below the bar nothing is filed and the Hygiene tab names what is behind.',
    enabled: 'auto',
    detect: 'a package file of one of those kinds is tracked; every ecosystem is one finding',
    cost: 'tool',
    cadence: 'weekly',
    idle: 'monthly',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'ci',
    summary:
      'The workflow files: a private repo runs on `[self-hosted, vps]` and never a hosted runner, `uses:` lines are pinned to a version or a sha, and, for a project whose `checks` says `ci: true`, a workflow calls the same `make` target the project names as its full check.',
    enabled: 'auto',
    detect: 'the repo has `.github/workflows/*.yml`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'agentsmd',
    summary:
      'The repo contract for agent files (dotfiles `docs/agents-md.md`): no `CLAUDE.md` or `CLAUDE.local.md`, no `@imports` in an `AGENTS.md`, no `ask` rules in a checked-in `.claude/settings.json`. A `CLAUDE.md` under a `fixtures/` directory is a documented benchmark fixture and is not a finding.',
    enabled: 'auto',
    detect: 'the repo has an `AGENTS.md`, a `CLAUDE.md` or a `.claude/settings.json`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'readme',
    summary: 'Every command (`make <target>`, `bun run <script>`) and path a `README.md` names exists in the repo.',
    enabled: 'auto',
    detect: 'the repo has a `README.md`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'stale',
    fix: {
      keys: ['stale:branches', 'stale:worktrees'],
      does: 'Deletes the remote branches merged into the default branch (`git push origin --delete`), prunes worktrees git calls prunable and removes the merged ones that are idle (`git worktree remove`, never `--force`: a dirty or locked one stays). The worktree of a lead (branch `factory/<issue>-<attempt>`, or its directory `factory-<issue>-<attempt>` once the branch is gone) is never touched: its finalization removes it.',
      lands:
        'On the remote and the project checkout at once. Branches only untouched for 30 days and worktrees only untouched are not deleted: they stay a finding for a lead.',
    },
    summary:
      'Remote branches merged into the default branch or untouched for 30 days, and leftover worktrees of branches that are gone.',
    enabled: 'on',
    detect: null,
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'deadcode',
    summary:
      'Unused files, exports and dependencies of a JavaScript or TypeScript repo (fallow, the analyzer behind the `analyze` skill); only the top findings.',
    enabled: 'auto',
    detect: 'the repo has a `package.json` and `fallow` is installed on the host',
    cost: 'tool',
    cadence: 'weekly',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'runrules',
    summary:
      "The owner's rules for what runs on the Mac mini (restart policy, memory limit, port binding, healthcheck, registered jobs), read from the files before a change reaches the host.",
    enabled: 'auto',
    detect: 'the repo has a root `mini-services.yaml`, or a deploy target on host `mini` in `project.yaml`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'browser',
    summary:
      "The owner's browser rule for suites and agent tooling: Playwright's bundled headless shell unless a line states why not, never headed, a command-line tool and a skill instead of an MCP server.",
    enabled: 'on',
    detect: null,
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'context',
    summary:
      'The byte budgets of the files an agent loads every turn: 12,000 bytes for the root `AGENTS.md`, 8,000 for a nested one.',
    enabled: 'auto',
    detect: 'the repo has an `AGENTS.md`',
    cost: 'file',
    cadence: 'daily',
    skippable: true,
    silence: SKIP,
  },
  {
    name: 'probe',
    summary:
      "The project's own probes: each is `make <target>` in the throwaway checkout, red on any exit but 0, filed as `probe:<name>`.",
    enabled: 'opt-in',
    detect: 'the project lists it under `hygiene.probes` in `project.yaml`',
    cost: 'make',
    cadence: 'weekly',
    skippable: false,
    silence: 'Remove it from `hygiene.probes`.',
  },
  {
    name: 'judgment',
    summary:
      'One agent reads the living documents whose code moved on since they were last edited, and those edited lately, and files `stale` and `slop` findings; the factory checks every answer again.',
    enabled: 'on',
    detect: null,
    cost: 'agent',
    cadence: 'weekly',
    idle: 'monthly',
    skippable: false,
    silence: 'Not switchable: it takes at most two sections of a pass and a held class stops it.',
  },
] as const satisfies readonly HygieneCatalogueEntry[]

export type CatalogueName = (typeof HYGIENE_CATALOGUE)[number]['name']

/** The probes a sweep runs by name, in the order they file: every entry but the project's own `probe`s and the document judgment. */
export const BUILT_IN_PROBE_NAMES = HYGIENE_CATALOGUE.map((entry) => entry.name).filter(
  (name): name is Exclude<CatalogueName, 'probe' | 'judgment'> => name !== 'probe' && name !== 'judgment',
)

/** The built-in probes `hygiene.skip` may name (`check` has `check: false`). */
export const SKIPPABLE_PROBES = HYGIENE_CATALOGUE.filter((entry) => entry.skippable).map((entry) => entry.name) as [
  Exclude<CatalogueName, 'check' | 'probe' | 'judgment'>,
  ...Exclude<CatalogueName, 'check' | 'probe' | 'judgment'>[],
]

export const catalogueEntry = (name: string): HygieneCatalogueEntry | undefined =>
  HYGIENE_CATALOGUE.find((entry) => entry.name === name)

/** The class a hygiene key names: a probe's first segment, a judgment's kind, a declared probe's name. */
export function hygieneClass(key: string): string {
  const [head = '', second = ''] = key.split(':')
  return head === 'judgment' || head === 'probe' ? second : head
}
