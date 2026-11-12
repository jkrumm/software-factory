import { DEFAULT_SLOT_RUN_MS, LaneName } from '@software-factory/contract'
import { issuesMessage } from '@software-factory/contract/plan'
import * as z from 'zod'

export { DEFAULT_SLOT_RUN_MS }

/** The project file's `apiVersion`. A file of another version is a broken one. */
export const PROJECT_API_VERSION = 'factory/v2'

/** The file is read from a repo's default branch; a larger one is a broken project, not a memory problem. */
export const MAX_PROJECT_BYTES = 64 * 1024

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

const Slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'letters, digits, dot, dash and underscore')

/** Whether a repo directory's name can be a project's name. */
export const isProjectDirName = (name: string): boolean => Slug.safeParse(name).success

/** `https://…` to GET, or `make <target>` to run in the repo. */
const Verify = z
  .string()
  .regex(/^(https?:\/\/\S+|make [A-Za-z0-9][A-Za-z0-9_.-]*)$/, 'a URL (http or https) or `make <target>`')

const Target = z.strictObject({ name: Slug, host: Slug, verify: Verify })

const Probe = z.strictObject({
  name: Slug,
  http: z.string().regex(/^https?:\/\/\S+$/, 'an http or https URL'),
  expect: z.number().int().min(100).max(599).default(200),
})

const DeployGlob = z.string().min(1)

const Deploy = z.strictObject({
  /** `auto`: a push deploys · `make`: `make deploy` · `agentic`: the lead deploys · `none` */
  mode: z.enum(['auto', 'make', 'agentic', 'none']).default('none'),
  targets: z.array(Target).default([]),
  /** how long a shipped change is watched before it counts as done (`30m`, `2h`, `1d`; at most 7 days) */
  hold: z
    .string()
    .refine((text) => {
      const ms = durationMs(text)
      return ms !== undefined && ms <= MAX_WATCH_MS
    }, 'a duration like 30m, 2h or 1d, at most 7d')
    .default('0m'),
  /**
   * globs of the paths a deploy carries (`apps/**`, `Makefile`). Empty: every path that is not inert deploys. Set: a ship
   * touching none of them records no deploy and no deployed-version check, as a rewrite built beside the running system must.
   */
  paths: z.array(DeployGlob).default([]),
  /** paths whose change needs a migration to be run */
  migrations: z.array(z.string().min(1)).default([]),
  probes: z.array(Probe).default([]),
})

/** `slots:`: the test-slot run limit of the project; `run` unset means `DEFAULT_SLOT_RUN_MS`. */
const Slots = z.strictObject({
  run: z
    .string()
    .refine((text) => {
      const ms = durationMs(text)
      return ms !== undefined && ms >= MIN_SLOT_RUN_MS && ms <= MAX_SLOT_RUN_MS
    }, 'a duration like 45m or 2h, at least 1m and at most 6h')
    .optional(),
})

/** `make <target>`: the one command form a check tier takes, so the brief quotes data and never a free shell line. */
const MakeCommand = z.string().regex(/^make [A-Za-z0-9][A-Za-z0-9_.-]*$/, '`make <target>`')

/**
 * `checks:`: the repo's check tiers. `fast` is what a lead runs locally before each push; `full` is the complete gate,
 * which CI runs on the pull request head when `ci` is true (the lead then relies on that run and `merge-guard` still
 * demands it green). A project without `checks:` is `null`: its lead runs `make check` as before.
 */
const Checks = z.strictObject({
  fast: MakeCommand,
  full: MakeCommand.default('make check'),
  ci: z.boolean().default(false),
})
export type CheckTiers = z.output<typeof Checks>

/**
 * `hygiene:`: what the hygiene loop may run on the project. `check: false` says the project's `make check` needs a lab
 * the factory host does not have (inputs only a person may supply); the loop skips that probe and names `reason` in its
 * pass. The reason is required: a probe is never switched off without one.
 */
const Hygiene = z
  .strictObject({
    check: z.boolean().default(true),
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .refine((hygiene) => hygiene.check || hygiene.reason !== undefined, {
    message: '`reason` is required when `check` is false',
    path: ['reason'],
  })

const LANE_MEMORY = /^(\d+(?:\.\d+)?)(MiB|GiB)$/
const MAX_LANE_MEMORY_MIB = 1024 * 1024

/** One lane: a cap on its leads, or `{leads, memory}` with the host memory each running lead of the lane reserves (`18GiB`). */
const Lane = z
  .union([
    z.number().int().min(1).max(8),
    // a stored project is read back through this schema: its lanes are already `{leads, memoryMib}`
    z.strictObject({ leads: z.number().int().min(1).max(8), memoryMib: z.number().int().min(0).nullable() }),
    z.strictObject({
      leads: z.number().int().min(1).max(8),
      memory: z
        .string()
        .regex(LANE_MEMORY, 'a size like 18GiB or 512MiB')
        .refine((text) => laneMemoryMib(text) <= MAX_LANE_MEMORY_MIB, 'at most 1 TiB')
        .optional(),
    }),
  ])
  .transform((lane) => {
    if (typeof lane === 'number') return { leads: lane, memoryMib: null }
    if ('memoryMib' in lane) return lane
    return { leads: lane.leads, memoryMib: lane.memory === undefined ? null : laneMemoryMib(lane.memory) }
  })

/** `18GiB` or `512MiB` as MiB; 0 for anything else. */
function laneMemoryMib(text: string): number {
  const match = LANE_MEMORY.exec(text)
  if (!match?.[1]) return 0
  return Math.round(Number(match[1]) * (match[2] === 'GiB' ? 1024 : 1))
}

/** First match wins. */
const ShipRule = z.strictObject({
  paths: z.array(z.string().min(1)).min(1),
  via: z.enum(['push', 'pr']),
})

/** One `heal:` rule: a `down` of the source waits `grace` for its `up`, after trying the runbook. */
const HealRule = z.strictObject({
  when: z
    .string()
    .regex(
      /^(kuma|hyperdx|github|checks|launchd)\.down$/,
      '`<source>.down` of kuma, hyperdx, github, checks or launchd',
    ),
  grace: z.string().refine((text) => {
    const ms = durationMs(text)
    return ms !== undefined && ms <= MAX_GRACE_MS
  }, 'a duration like 30s, 30m, 2h or 1d, at most 1d'),
  runbook: z.literal('make restart').optional(),
  max: z.number().int().min(1).max(5).default(1),
})

/**
 * Which automatic sources a project listens to. Intake reads this through its `IntakeTopology` port; a work repo lists
 * none and hears the owner only.
 */
const Signals = z.looseObject({
  github: z
    .strictObject({
      label: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[A-Za-z0-9 ._-]+$/, 'letters, digits, space, dot, dash and underscore')
        .default('factory'),
      checks: z.boolean().default(false),
      author: z
        .string()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'a GitHub login')
        .optional(),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z)?$/, 'YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS)Z')
        .refine((value) => !Number.isNaN(Date.parse(value)), 'a real date')
        .optional(),
    })
    .refine((github) => (github.author === undefined) === (github.since === undefined), {
      message: '`author` and `since` are set together: both or neither',
    })
    .optional(),
  launchd: z.array(z.string().min(1).max(200)).max(64).optional(),
  kuma: z.unknown().optional(),
  hyperdx: z.unknown().optional(),
})

/** A rule that settles a recurring Decision once and for all: a phrase of the question and the option label it takes. */
const PolicyRule = z.strictObject({
  when: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
})
export type PolicyRule = z.output<typeof PolicyRule>

/**
 * `project.yaml`. A key the schema does not know is an error, so a typo is not read as a default; `jobs` and `ticktick`
 * are accepted and dropped so a file written for an older core still parses.
 */
export const ProjectFile = z
  .strictObject({
    apiVersion: z.literal(PROJECT_API_VERSION),
    name: Slug,
    /** the host the project's alerts sit on, a key of config/infra.json's hosts (e.g. `macmini`) */
    host: Slug.optional(),
    deploy: Deploy.default(() => Deploy.parse({})),
    ship: z
      .array(ShipRule)
      .min(1)
      .default(() => [{ paths: ['**'], via: 'push' as const }]),
    /**
     * `true`: the repo stays a work repo though it has a `project.yaml`: the read token never sees its words and it hears
     * the owner only. For a repo of another organisation that the factory builds in.
     */
    work: z.boolean().default(false),
    /** how many leads may work in the repo at once (one more for a fix while the line is stopped) */
    leads: z.number().int().min(1).max(8).default(1),
    /**
     * resource classes inside the repo: `{apple: 1}` lets one lead of lane apple run at once; `{apple: {leads: 1, memory:
     * 18GiB}}` also reserves that memory on the host for every running lead of the lane. A lane a row or Issue names and
     * this does not declare is unlimited within `leads`; a cap above `leads` limits nothing.
     */
    lanes: z.record(LaneName, Lane).default({}),
    slots: Slots.default({}),
    /** check tiers: a fast local check and the full gate (CI's when `ci` is true); `null` keeps one `make check` */
    checks: Checks.nullable().default(null),
    hygiene: Hygiene.default(() => Hygiene.parse({})),
    signals: Signals.default({}),
    heal: z.array(HealRule).max(32).default([]),
    /** standing policy: the first rule whose phrase the question contains and whose answer is one of its options settles it */
    policy: z.array(PolicyRule).max(64).default([]),
    jobs: z.unknown().optional(),
    ticktick: z.unknown().optional(),
  })
  .transform(({ jobs: _jobs, ticktick: _ticktick, ...kept }) => kept)
export type ProjectFile = z.output<typeof ProjectFile>

/** What a repo without a `project.yaml` runs on: one lead, no deploy, ship by push. */
export const defaultProject = (name: string): ProjectFile =>
  ProjectFile.parse({ apiVersion: PROJECT_API_VERSION, name })

export type ProjectParse = { ok: true; project: ProjectFile } | { ok: false; message: string }

export { issuesMessage }

/** A parsed YAML document as a project whose name is the directory's. Never throws. */
export function parseProject(raw: unknown, directoryName: string): ProjectParse {
  const parsed = ProjectFile.safeParse(raw)
  if (!parsed.success) return { ok: false, message: issuesMessage(parsed.error) }
  if (parsed.data.name !== directoryName) {
    return { ok: false, message: `name is "${parsed.data.name}", the directory is "${directoryName}"` }
  }
  return { ok: true, project: parsed.data }
}
