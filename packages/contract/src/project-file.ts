import * as z from 'zod'
import { DEFAULT_SLOT_RUN_MS } from './capacity.ts'
import { LaneName } from './lane.ts'
import { issuesMessage } from './plan-file.ts'

/**
 * `project.yaml`: what a repo declares to the factory, shared by the server (`factory project sync`), the offline
 * `factory project check` and the JSON Schema an editor reads (`schema/project.schema.json`, generated from this file by
 * `scripts/project-schema.ts`). Every key carries its description and the code that reads it (`consumer`), so the editor
 * hover, `docs/project.md`'s key reference and the code are one source. A subpath export (`@software-factory/contract/project`).
 */

export { DEFAULT_SLOT_RUN_MS, issuesMessage }

/** The project file's `apiVersion`. A file of another version is a broken one. */
export const PROJECT_API_VERSION = 'factory/v2'

/** The file is read from a repo's default branch; a larger one is a broken project, not a memory problem. */
export const MAX_PROJECT_BYTES = 64 * 1024

/** Where the generated JSON Schema is published: the public repo's file on its default branch. */
export const PROJECT_SCHEMA_URL =
  'https://raw.githubusercontent.com/jkrumm/software-factory/master/schema/project.schema.json'

/** `description` is the editor hover and the page's words; `consumer` names the code that reads the key. */
const about = (description: string, consumer: string, shown?: { shownDefault: unknown }) => ({
  description,
  consumer,
  ...shown,
})

/** A key the factory accepts and drops: read by nothing. `factory project check` warns on it so it can be removed. */
const retired = (description: string) => ({ description, consumer: 'nothing (retired)', deprecated: true })

const DURATION = /^(\d+)(s|m|h|d)$/
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const MAX_WATCH_MS = 7 * UNIT_MS.d
const MAX_GRACE_MS = UNIT_MS.d
const MIN_SLOT_RUN_MS = UNIT_MS.m
const MAX_SLOT_RUN_MS = 6 * UNIT_MS.h

/** `30m`, `2h`, `1d`: milliseconds, or `undefined` for anything else. */
export function durationMs(text: string): number | undefined {
  const match = DURATION.exec(text)
  if (!match) return undefined
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
}

/** A duration (`30s`, `30m`, `2h`, `1d`) within the bounds; the pattern reaches the JSON Schema, the bounds stay here. */
const Duration = (bounds: { min?: number; max?: number }, words: string) =>
  z
    .string()
    .regex(DURATION, words)
    .refine((text) => {
      const ms = durationMs(text) ?? -1
      return ms >= (bounds.min ?? 0) && ms <= (bounds.max ?? Number.MAX_SAFE_INTEGER)
    }, words)

const Slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'letters, digits, dot, dash and underscore')

/** Whether a repo directory's name can be a project's name. */
export const isProjectDirName = (name: string): boolean => Slug.safeParse(name).success

/** `https://…` to GET, or `make <target>` to run in the repo. */
const Verify = z
  .string()
  .regex(/^(https?:\/\/\S+|make [A-Za-z0-9][A-Za-z0-9_.-]*)$/, 'a URL (http or https) or `make <target>`')

/** `make <target>`: the one command form a check tier takes, so the brief quotes data and never a free shell line. */
const MakeCommand = z.string().regex(/^make [A-Za-z0-9][A-Za-z0-9_.-]*$/, '`make <target>`')

const WATCH = 'the Watch (apps/server/src/app/quality-projects.ts)'

const Target = z.strictObject({
  name: Slug.meta(about("the target's name, shown on the project page (`mini`, `prod`)", WATCH)),
  host: Slug.optional().meta(
    about(
      'the machine the target runs on (`mini`, `vps`, `homelab`). `mini` makes the weekly hygiene pass judge the repo against the run rules for the mini (`runrules`), which it otherwise does only for a repo with a root `mini-services.yaml`',
      'the hygiene runrules probe (apps/server/src/adapters/hygiene/probes/runrules.ts, read from the raw file)',
    ),
  ),
  verify: Verify.meta(
    about(
      'how a deploy is proved: `make verify` (or another `make <target>`) run in the repo, or an http(s) URL the Watch GETs and expects 200 from',
      WATCH,
    ),
  ),
})

const Probe = z.strictObject({
  name: Slug.meta(about("the probe's name in the Watch's evidence", WATCH)),
  http: z
    .string()
    .regex(/^https?:\/\/\S+$/, 'an http or https URL')
    .meta(about('the URL the Watch GETs', WATCH)),
  expect: z.number().int().min(100).max(599).default(200).meta(about('the HTTP status the probe expects', WATCH)),
})

const Deploy = z
  .strictObject({
    mode: z
      .enum(['auto', 'make', 'agentic', 'none'])
      .default('none')
      .meta(
        about(
          'how a shipped change reaches production. `auto`: a push to the default branch deploys (CI, Vercel, RollHook), the Watch asks no `make version`; `make`: the lead runs `make deploy` and `make version` reads the live sha; `agentic`: the lead deploys by its own steps; `none`: nothing deploys, done is merged with CI green',
          WATCH,
        ),
      ),
    targets: z
      .array(Target)
      .default([])
      .meta(
        about(
          'where a deploy is verified, one entry per place. Empty: the Watch runs `make verify` when the Makefile has it',
          WATCH,
          { shownDefault: [] },
        ),
      ),
    hold: Duration({ max: MAX_WATCH_MS }, 'a duration like 30m, 2h or 1d, at most 7d')
      .default('0m')
      .meta(
        about(
          'how long a shipped change is watched before it counts as done (`30m`, `2h`, `1d`, at most 7d). Give an asynchronous deploy (CI, a rolling swap) its time here',
          WATCH,
        ),
      ),
    paths: z
      .array(z.string().min(1))
      .default([])
      .meta(
        about(
          'globs of the paths a deploy carries (`apps/**`, `Makefile`). Empty: every path that is not inert deploys. Set: a ship touching none of them records no deploy and no deployed-version check, as a rewrite built beside the running system must',
          'the ship gate (apps/server/src/domains/quality/gate.ts) and the Watch',
        ),
      ),
    migrations: z
      .array(z.string())
      .optional()
      .meta(
        retired(
          "Retired: read by nothing; no gate or brief ever used it. Where migrations live and how they run belongs in the repo's AGENTS.md. Remove it.",
        ),
      ),
    probes: z
      .array(Probe)
      .default([])
      .meta(about('HTTP probes the Watch runs after every deploy, beside the targets', WATCH)),
  })
  .transform(({ migrations: _migrations, ...kept }) => kept)

/** `slots:`: the test-slot run limit of the project; `run` unset means `DEFAULT_SLOT_RUN_MS`. */
const Slots = z.strictObject({
  run: Duration({ min: MIN_SLOT_RUN_MS, max: MAX_SLOT_RUN_MS }, 'a duration like 45m or 2h, at least 1m and at most 6h')
    .optional()
    .meta(
      about(
        `how long one \`factory slot run\` of this repo may hold a test slot before it is stopped (at least 1m, at most 6h; unset: ${DEFAULT_SLOT_RUN_MS / 60_000}m)`,
        'test slots (apps/server/src/app/capacity-slots.ts)',
      ),
    ),
})

const SIZE = /^(\d+(?:\.\d+)?)(MiB|GiB)$/
const PERCENT = /^(\d+(?:\.\d+)?)%$/
const THROUGHPUT = 'the throughput loop (apps/server/src/app/loops/throughput.ts)'

const Budgets = z.strictObject({
  fast: Duration({ min: 1000 }, 'a duration like 90s or 2m')
    .optional()
    .meta(about("the most the median of a day's fast-tier check runs may take (`5m`)", THROUGHPUT)),
  peak: z
    .string()
    .regex(SIZE, 'a size like 2GiB or 512MiB')
    .optional()
    .meta(about('the most peak memory one check step may take (`4GiB`)', THROUGHPUT)),
  fail: z
    .string()
    .regex(PERCENT, 'a share like 10%')
    .refine((text) => {
      const share = Number(PERCENT.exec(text)?.[1])
      return share > 0 && share <= 100
    }, 'a share like 10%')
    .optional()
    .meta(about("the most of a day's check steps that may exit non-zero (`30%`)", THROUGHPUT)),
})

/** A project's budgets as numbers: milliseconds, MiB, a share of 1; each `null` when the project sets none. */
export function budgetsOf(project: Pick<ProjectFile, 'budgets'>): {
  fastMs: number | null
  peakMib: number | null
  failShare: number | null
} {
  const { fast, peak, fail } = project.budgets
  const size = peak === undefined ? null : SIZE.exec(peak)
  const share = fail === undefined ? null : PERCENT.exec(fail)
  return {
    fastMs: fast === undefined ? null : (durationMs(fast) ?? null),
    peakMib: size ? Number(size[1]) * (size[2] === 'GiB' ? 1024 : 1) : null,
    failShare: share ? Number(share[1]) / 100 : null,
  }
}

const BRIEF = "the lead's brief (apps/server/src/domains/leads/brief.ts)"

const Checks = z.strictObject({
  fast: MakeCommand.meta(about('what a lead runs locally before each push (`make check-fast`)', BRIEF)),
  full: MakeCommand.default('make check').meta(about('the complete gate', BRIEF)),
  ci: z
    .boolean()
    .default(false)
    .meta(
      about(
        '`true`: CI runs `full` on the pull request head, so the lead runs only `fast` and relies on that run (`make merge-guard` still demands it green)',
        BRIEF,
      ),
    ),
})
export type CheckTiers = z.output<typeof Checks>

/** The most probes a project may declare: each is a `make` run per weekly pass, and the pass files at most 3 probe findings. */
const MAX_DECLARED_PROBES = 16

const HYGIENE = 'the hygiene loop (apps/server/src/app/loops/hygiene.ts)'

const DeclaredProbe = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, 'lowercase letters, digits and dashes, at most 64')
    .meta(about("the probe's name; a finding is keyed `probe:<name>`", HYGIENE)),
  target: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, 'a Makefile target of lowercase letters, digits and dashes')
    .meta(
      about(
        'the Makefile target the loop runs as `make <target>` in a throwaway checkout; any exit but 0 is a finding',
        HYGIENE,
      ),
    ),
})

/** The built-in hygiene probes a project may switch off (`check` has `check: false`, the declared `probes` are the project's own). */
const SKIPPABLE_PROBES = ['links', 'retired', 'deps', 'cochange', 'runrules', 'browser', 'context'] as const

const SkippedProbe = z.strictObject({
  probe: z.enum(SKIPPABLE_PROBES).meta(about('the built-in probe switched off', HYGIENE)),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .meta(about('why: a probe is never switched off without one; the pass shows it', HYGIENE)),
})

const Hygiene = z
  .strictObject({
    check: z
      .boolean()
      .default(true)
      .meta(
        about(
          "`false`: the repo's `make check` needs a lab the factory host does not have, so the weekly pass skips its `check` probe (with `reason`)",
          HYGIENE,
        ),
      ),
    reason: z.string().trim().min(1).max(300).optional().meta(about('why `check` is false; required then', HYGIENE)),
    skip: z
      .array(SkippedProbe)
      .max(SKIPPABLE_PROBES.length)
      .refine((list) => new Set(list.map((entry) => entry.probe)).size === list.length, 'a probe is named once')
      .default([])
      .meta(
        about(`built-in probes the repo opts out of, each with its reason (${SKIPPABLE_PROBES.join(', ')})`, HYGIENE),
      ),
    probes: z
      .array(DeclaredProbe)
      .max(MAX_DECLARED_PROBES)
      .refine((list) => new Set(list.map((probe) => probe.name)).size === list.length, 'probe names are unique')
      .default([])
      .meta(about(`the repo's own weekly probes, at most ${MAX_DECLARED_PROBES}`, HYGIENE)),
  })
  .refine((hygiene) => hygiene.check || hygiene.reason !== undefined, {
    message: '`reason` is required when `check` is false',
    path: ['reason'],
  })

/** The most leads a repo, or a lane of it, may state: a value above is clamped to it, with a warning, never refused. */
export const MAX_LEADS = 64

/**
 * The leads of a repo whose `project.yaml` states none (and of a repo with none): no cap beyond the host, whose memory
 * fit, load and accounts hold work back. A `leads: N` below it is an exception the file gives its reason for (NL32).
 */
export const DEFAULT_LEADS = MAX_LEADS

const LANE_MEMORY = /^(\d+(?:\.\d+)?)(MiB|GiB)$/
const MAX_LANE_MEMORY_MIB = 1024 * 1024

/** `18GiB` or `512MiB` as MiB; 0 for anything else. */
function laneMemoryMib(text: string): number {
  const match = LANE_MEMORY.exec(text)
  if (!match?.[1]) return 0
  return Math.round(Number(match[1]) * (match[2] === 'GiB' ? 1024 : 1))
}

const ADMISSION = 'admission (apps/server/src/app/capacity-admit.ts)'

const LaneLeads = z.number().int().min(1).max(MAX_LEADS)

/** One lane as a file writes it: a cap on its leads, or `{leads, memory}` with the host memory each running lead reserves. */
const AuthoredLane = z.union([
  LaneLeads.meta(about('how many leads of the lane run at once', ADMISSION)),
  z.strictObject({
    leads: LaneLeads.meta(about('how many leads of the lane run at once', ADMISSION)),
    memory: z
      .string()
      .regex(LANE_MEMORY, 'a size like 18GiB or 512MiB')
      .refine((text) => laneMemoryMib(text) <= MAX_LANE_MEMORY_MIB, 'at most 1 TiB')
      .optional()
      .meta(about('the host memory each running lead of the lane reserves (`18GiB`, at most 1 TiB)', ADMISSION)),
  }),
])

/** A lane as stored: what `AuthoredLane` becomes. A stored project is read back through `StoredProjectFile`. */
const StoredLane = z.strictObject({ leads: LaneLeads, memoryMib: z.number().int().min(0).nullable() })

const toStoredLane = (
  lane: z.output<typeof AuthoredLane> | z.output<typeof StoredLane>,
): z.output<typeof StoredLane> => {
  if (typeof lane === 'number') return { leads: lane, memoryMib: null }
  if ('memoryMib' in lane) return lane
  return { leads: lane.leads, memoryMib: lane.memory === undefined ? null : laneMemoryMib(lane.memory) }
}

const ShipRule = z
  .strictObject({
    paths: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .meta(
        retired(
          'Retired: read by nothing; no code ever matched a change against these globs. The factory reads only whether any rule ships `via: pr`. Remove it.',
        ),
      ),
    via: z
      .enum(['push', 'pr'])
      .meta(
        about(
          '`pr`: changes land through a pull request, so the Watch expects CI on the head; `push`: straight to the default branch',
          WATCH,
        ),
      ),
  })
  .transform(({ paths: _paths, ...kept }) => kept)

const INTAKE = 'intake (apps/server/src/domains/planning/signals.ts)'

const Signals = z.strictObject({
  github: z
    .strictObject({
      label: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[A-Za-z0-9 ._-]+$/, 'letters, digits, space, dot, dash and underscore')
        .default('factory')
        .meta(about('a GitHub issue with this label is filed as a signal, whoever opened it', INTAKE)),
      checks: z
        .boolean()
        .default(false)
        .meta(about('`true`: a red check run on the default branch is filed as a signal', INTAKE)),
      author: z
        .string()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'a GitHub login')
        .optional()
        .meta(about('every new issue this login opens is filed without the label; set together with `since`', INTAKE)),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z)?$/, 'YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS)Z')
        .refine((value) => !Number.isNaN(Date.parse(value)), 'a real date')
        .optional()
        .meta(about('issues of `author` opened before this are never filed; set together with `author`', INTAKE)),
    })
    .refine((github) => (github.author === undefined) === (github.since === undefined), {
      message: '`author` and `since` are set together: both or neither',
    })
    .optional()
    .meta(about("the repo's GitHub issues and check runs come in as signals", INTAKE)),
  launchd: z
    .array(z.string().min(1).max(200))
    .max(64)
    .optional()
    .meta(
      about(
        'LaunchAgent labels on the mini whose crash or failed exit is filed as a signal on this repo',
        'launchd intake (apps/server/src/adapters/intake/launchd.ts)',
      ),
    ),
})

const HealRule = z.strictObject({
  when: z
    .string()
    .regex(
      /^(kuma|hyperdx|github|checks|launchd)\.down$/,
      '`<source>.down` of kuma, hyperdx, github, checks or launchd',
    )
    .meta(about('`<source>.down`: the alert this rule settles', 'intake (apps/server/src/app/intake.ts)')),
  grace: Duration({ max: MAX_GRACE_MS }, 'a duration like 30s, 30m, 2h or 1d, at most 1d').meta(
    about(
      'how long the `down` waits for its `up` before it is filed (at most 1d)',
      'intake (apps/server/src/app/intake.ts)',
    ),
  ),
  runbook: z
    .literal('make restart')
    .optional()
    .meta(about('run first, before the grace starts', 'intake (apps/server/src/app/intake.ts)')),
  max: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(1)
    .meta(about('how many heals in a row before it is filed anyway', 'intake (apps/server/src/app/intake.ts)')),
})

const POLICIES = 'Decision policies (apps/server/src/app/planning-policies.ts)'

/** A rule that settles a recurring Decision once and for all: a phrase of the question and the option label it takes. */
const PolicyRule = z.strictObject({
  when: z.string().trim().min(1).max(300).meta(about("a phrase the Decision's question contains", POLICIES)),
  answer: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .meta(about('the option label the rule takes; it must be one of the options', POLICIES)),
  reason: z.string().trim().min(1).max(500).meta(about('why, recorded with the answer', POLICIES)),
})
export type PolicyRule = z.output<typeof PolicyRule>

type LaneSchema = typeof AuthoredLane | z.ZodUnion<[typeof AuthoredLane, typeof StoredLane]>

/** The file's keys, with `lane` the form a lane takes: as written (the file) or also as stored (a stored row read back). */
const projectObject = <L extends LaneSchema>(lane: L) =>
  z
    .strictObject({
      apiVersion: z
        .literal(PROJECT_API_VERSION)
        .meta(
          about(
            `the file format; \`${PROJECT_API_VERSION}\`, any other is a broken file`,
            'sync (apps/server/src/domains/planning/sync.ts)',
          ),
        ),
      name: Slug.meta(
        about(
          "the repo's directory name; a file whose name is not its directory's is refused",
          'sync (apps/server/src/domains/planning/sync.ts)',
        ),
      ),
      host: Slug.optional().meta(
        about(
          "the host the repo's alerts sit on, a key of config/infra.json's hosts (`macmini`), so its Kuma and HyperDX alerts join that host's incident",
          INTAKE,
        ),
      ),
      deploy: Deploy.default(() => Deploy.parse({})).meta(
        about('how a shipped change is deployed and watched', WATCH, { shownDefault: {} }),
      ),
      ship: z
        .array(ShipRule)
        .min(1)
        .default(() => [{ via: 'push' as const }])
        .meta(
          about('how a change lands: a list of `{ via }` rules; any `via: pr` makes the Watch expect CI', WATCH, {
            shownDefault: [{ via: 'push' }],
          }),
        ),
      work: z
        .boolean()
        .default(false)
        .meta(
          about(
            '`true`: the repo stays a work repo though it has a project.yaml: the read token never sees its words and it hears the owner only. For a repo of another organisation the factory builds in',
            'read redaction and intake (apps/server/src/domains/planning/signals.ts, apps/server/src/api/planning.ts)',
          ),
        ),
      leads: z
        .number()
        .int()
        .min(1)
        .max(MAX_LEADS)
        .default(DEFAULT_LEADS)
        .meta(
          about(
            `how many leads may work in the repo at once (one more for a fix while the line is stopped). Unset: ${DEFAULT_LEADS}, no cap beyond the host's memory, load and accounts; a value above ${MAX_LEADS} is clamped with a warning. A lower cap is an exception the file gives its reason for (NL32)`,
            ADMISSION,
          ),
        ),
      lanes: z
        .record(LaneName, lane)
        .transform((lanes) =>
          Object.fromEntries(Object.entries(lanes).map(([name, value]) => [name, toStoredLane(value)])),
        )
        .default({})
        .meta(
          about(
            'resource classes inside the repo: `{apple: 1}` lets one lead of lane apple run at once; `{apple: {leads: 1, memory: 18GiB}}` also reserves that memory on the host for every running lead of the lane. A lane a row or Issue names and this does not declare is unlimited within `leads`',
            ADMISSION,
            { shownDefault: {} },
          ),
        ),
      slots: Slots.default({}).meta(
        about("the repo's test-slot limits", 'test slots (apps/server/src/app/capacity-slots.ts)'),
      ),
      budgets: Budgets.default({}).meta(
        about(
          "what the repo's checks may cost; a day over one is a signal on the repo. A key left out is no budget",
          THROUGHPUT,
        ),
      ),
      checks: Checks.nullable()
        .default(null)
        .meta(
          about(
            "check tiers: a fast local check and the full gate (CI's when `ci` is true). Unset: the lead runs `make check`",
            BRIEF,
          ),
        ),
      doctor: MakeCommand.nullable()
        .default(null)
        .meta(
          about(
            '`make doctor`: a read-only command of seconds that exits 0 when this host can run the project, else non-zero with one line per missing prerequisite and its fix. Red keeps every lead of the repo from being admitted and the hygiene `check` probe from running',
            `${ADMISSION} and ${HYGIENE}`,
          ),
        ),
      hygiene: Hygiene.default(() => Hygiene.parse({})).meta(
        about('what the weekly hygiene pass runs on the repo', HYGIENE),
      ),
      signals: Signals.default({}).meta(
        about('which automatic sources the repo listens to; a work repo lists none and hears the owner only', INTAKE),
      ),
      heal: z
        .array(HealRule)
        .max(32)
        .default([])
        .meta(
          about(
            'alerts that wait for their own recovery before they are filed',
            'intake (apps/server/src/app/intake.ts)',
          ),
        ),
      policy: z
        .array(PolicyRule)
        .max(64)
        .default([])
        .meta(
          about(
            'standing answers: the first rule whose phrase the question contains and whose answer is one of its options settles a Decision',
            POLICIES,
          ),
        ),
      jobs: z.unknown().optional().meta(retired('Retired with the old core; accepted and dropped. Remove it.')),
      ticktick: z.unknown().optional().meta(retired('Retired with the old core; accepted and dropped. Remove it.')),
    })
    .transform(({ jobs: _jobs, ticktick: _ticktick, ...kept }) => kept)

/**
 * `project.yaml` as a file writes it. A key the schema does not know is an error, so a typo is not read as a default;
 * a retired key is accepted and dropped so a file written before it was retired still parses.
 */
export const ProjectFile = projectObject(AuthoredLane)
export type ProjectFile = z.output<typeof ProjectFile>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A stored project read back: the file's output, whose lanes are already `{leads, memoryMib}`. A row stored while
 * `signals` was loose may still carry `kuma` or `hyperdx` (read by nothing): they are dropped, so the row still reads.
 */
export const StoredProjectFile = z.preprocess(
  (row) => {
    if (!isRecord(row) || !isRecord(row.signals)) return row
    const { kuma: _kuma, hyperdx: _hyperdx, ...signals } = row.signals
    return { ...row, signals }
  },
  projectObject(z.union([AuthoredLane, StoredLane])),
)

/** What a repo without a `project.yaml` runs on: `DEFAULT_LEADS` leads, no deploy, ship by push. */
export const defaultProject = (name: string): ProjectFile =>
  ProjectFile.parse({ apiVersion: PROJECT_API_VERSION, name })

export type ProjectParse = { ok: true; project: ProjectFile; warnings: string[] } | { ok: false; message: string }

/**
 * A `leads` above `MAX_LEADS`, of the repo or of a lane, is clamped to it and named in a warning: a value over a bound
 * must not take the whole file out of force. Anything else that is not a whole number from 1 stays the schema's error.
 */
function clampLeads(raw: unknown): { raw: unknown; warnings: string[] } {
  if (!isRecord(raw)) return { raw, warnings: [] }
  const warnings: string[] = []
  const clamp = (value: unknown, where: string): unknown => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= MAX_LEADS) return value
    warnings.push(`${where} is ${value}, above the most a repo or lane takes: clamped to ${MAX_LEADS}`)
    return MAX_LEADS
  }
  const next: Record<string, unknown> = { ...raw, ...('leads' in raw ? { leads: clamp(raw.leads, 'leads') } : {}) }
  if (isRecord(raw.lanes)) {
    next.lanes = Object.fromEntries(
      Object.entries(raw.lanes).map(([name, lane]) => [
        name,
        isRecord(lane) && 'leads' in lane
          ? { ...lane, leads: clamp(lane.leads, `lanes.${name}.leads`) }
          : clamp(lane, `lanes.${name}`),
      ]),
    )
  }
  return { raw: next, warnings }
}

/** The clamped document and the result of the schema, before the name is compared with the directory. */
export function readProject(raw: unknown): {
  clamped: unknown
  warnings: string[]
  parsed: ReturnType<typeof ProjectFile.safeParse>
} {
  const { raw: clamped, warnings } = clampLeads(raw)
  return { clamped, warnings, parsed: ProjectFile.safeParse(clamped) }
}

/** A parsed YAML document as a project whose name is the directory's, with the warnings of what was clamped. Never throws. */
export function parseProject(raw: unknown, directoryName: string): ProjectParse {
  const { parsed, warnings } = readProject(raw)
  if (!parsed.success) return { ok: false, message: issuesMessage(parsed.error) }
  if (parsed.data.name !== directoryName) {
    return { ok: false, message: `name is "${parsed.data.name}", the directory is "${directoryName}"` }
  }
  return { ok: true, project: parsed.data, warnings }
}

/**
 * The JSON Schema of the file as an author writes it (draft-07, the widest editor support): the descriptions are the
 * hover text, `consumer` names what reads a key, `deprecated` marks a retired one. Committed as
 * `schema/project.schema.json` and served at `GET /v1/schema/project`.
 */
export function projectJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ProjectFile, {
    io: 'input',
    target: 'draft-7',
    unrepresentable: 'any',
    // zod drops the default of a key whose value is transformed (input mode); `shownDefault` puts the author's default back
    override: ({ zodSchema, jsonSchema }) => {
      const shown = z.globalRegistry.get(zodSchema)?.shownDefault
      if (shown === undefined) return
      delete (jsonSchema as Record<string, unknown>).shownDefault
      jsonSchema.default = shown
    },
  })
  const { $schema, ...rest } = schema as Record<string, unknown>
  return {
    $schema,
    $id: PROJECT_SCHEMA_URL,
    title: 'project.yaml',
    description:
      "A repo's declaration to the software factory: how it ships, deploys, checks and is watched. The author page is docs/project.md.",
    ...rest,
  }
}
