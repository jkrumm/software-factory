import { z } from 'zod'
import { PlanView } from './plan.ts'

/** The manifest's `apiVersion`. A manifest of another version is a broken one. */
export const MANIFEST_API_VERSION = 'factory/v2'

/** The file is read from the default branch of a repo; a larger one is a broken manifest, not a memory problem. */
export const MAX_MANIFEST_BYTES = 64 * 1024

export const DEFAULT_HOLD = '0m'

const DURATION = /^(\d+)(s|m|h|d)$/
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const MAX_HOLD_MS = 7 * UNIT_MS.d
const MAX_GRACE_MS = UNIT_MS.d
const MIN_SLOT_RUN_MS = UNIT_MS.m
const MAX_SLOT_RUN_MS = 6 * UNIT_MS.h

/** `30m`, `2h`, `1d`: milliseconds, or `undefined` for anything else. */
export function durationMs(text: string): number | undefined {
  const match = DURATION.exec(text)
  if (!match) return undefined
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
}

/** The hold where nothing says otherwise, from the one default there is. */
export const DEFAULT_HOLD_MS = durationMs(DEFAULT_HOLD) ?? 0

/** `https://…` to GET, or `make <target>` to run in the repo. */
const Verify = z
  .string()
  .regex(/^(https?:\/\/\S+|make [A-Za-z0-9][A-Za-z0-9_.-]*)$/, 'a URL (http or https) or `make <target>`')

const Slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'letters, digits, dot, dash and underscore')

/** Whether a repo directory's name can be a project (and its default manifest's name): the one test sync and the store share. */
export const isProjectDirName = (name: string): boolean => Slug.safeParse(name).success

const Target = z.strictObject({ name: Slug, host: Slug, verify: Verify })

const Probe = z.strictObject({
  name: Slug,
  http: z.string().regex(/^https?:\/\/\S+$/, 'an http or https URL'),
  expect: z.number().int().min(100).max(599).default(200),
})

const Deploy = z.strictObject({
  /** `auto`: a push deploys · `make`: `make deploy` · `agentic`: the lead deploys · `none` */
  mode: z.enum(['auto', 'make', 'agentic', 'none']).default('none'),
  targets: z.array(Target).default([]),
  /** how long a shipped change is watched before it counts as closed (`30m`, `2h`, `1d`; at most 7 days) */
  hold: z
    .string()
    .refine((hold) => {
      const ms = durationMs(hold)
      return ms !== undefined && ms <= MAX_HOLD_MS
    }, 'a duration like 30m, 2h or 1d, at most 7d')
    .default(DEFAULT_HOLD),
  /** paths whose change needs a migration to be run */
  migrations: z.array(z.string().min(1)).default([]),
  probes: z.array(Probe).default([]),
})

/** `slots:`: the test-slot run limit of the project (design FL7); `run` unset means `DEFAULT_SLOT_RUN_MS`. */
const Slots = z.strictObject({
  run: z
    .string()
    .refine((run) => {
      const ms = durationMs(run)
      return ms !== undefined && ms >= MIN_SLOT_RUN_MS && ms <= MAX_SLOT_RUN_MS
    }, 'a duration like 45m or 2h, at least 1m and at most 6h')
    .optional(),
})

/** First match wins. */
const ShipRule = z.strictObject({
  paths: z.array(z.string().min(1)).min(1),
  via: z.enum(['push', 'pr']),
})

const DEFAULT_DEPLOY = Deploy.parse({})

/** One `heal:` rule (design §4 "Intake"): a `down` of the source waits `grace` for its `up`, after trying the runbook. */
const HealRule = z.strictObject({
  when: z
    .string()
    .regex(
      /^(kuma|hyperdx|github|checks|launchd)\.down$/,
      '`<source>.down` of kuma, hyperdx, github, checks or launchd',
    ),
  /** how long a `down` waits for its `up` (`30s`, `30m`, `2h`, `1d`; at most 1 day) */
  grace: z.string().refine((grace) => {
    const ms = durationMs(grace)
    return ms !== undefined && ms <= MAX_GRACE_MS
  }, 'a duration like 30s, 30m, 2h or 1d, at most 1d'),
  runbook: z.literal('make restart').optional(),
  /** how often the runbook runs before the `down` is filed */
  max: z.number().int().min(1).max(5).default(1),
})
export type HealRule = z.output<typeof HealRule>

/** What a project tells the intake sources about itself; `kuma` and `hyperdx` are the door's routes and stay unread here. */
const Signals = z.looseObject({
  github: z
    .strictObject({
      /** the label that puts a GitHub issue on the project's poll */
      label: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[A-Za-z0-9 ._-]+$/, 'letters, digits, space, dot, dash and underscore')
        .default('factory'),
      /** opt in to the default branch's red checks and commit statuses as `checks` signals */
      checks: z.boolean().default(false),
      /**
       * author mode: the GitHub login whose new issues come in without a label (everyone else's need the label). Set together
       * with `since`
       */
      author: z
        .string()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'a GitHub login')
        .optional(),
      /**
       * the cut-over of author mode: only issues created at or after it are admitted, so the backlog is not filed. `YYYY-MM-DD` or a
       * UTC datetime `YYYY-MM-DDTHH:MM(:SS)Z`. Set together with `author`
       */
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

/**
 * `project.yaml`. `signals` and `heal` are parsed and kept (the intake reads them); the keys F3 still brings (`jobs`, `ticktick`) are
 * accepted and dropped, so a manifest written for F3 does not break; any other key is an error, so a typo is not read as a default.
 */
export const ProjectManifest = z
  .strictObject({
    apiVersion: z.literal(MANIFEST_API_VERSION),
    name: Slug,
    deploy: Deploy.default(DEFAULT_DEPLOY),
    ship: z
      .array(ShipRule)
      .min(1)
      .default([{ paths: ['**'], via: 'push' }]),
    leads: z.number().int().min(1).max(8).default(1),
    slots: Slots.default({}),
    signals: Signals.default({}),
    heal: z.array(HealRule).max(32).default([]),
    jobs: z.unknown().optional(),
    ticktick: z.unknown().optional(),
  })
  .transform(({ jobs: _jobs, ticktick: _ticktick, ...kept }) => kept)
export type ProjectManifest = z.output<typeof ProjectManifest>

/** What a project without a manifest runs on: requests only, one lead, no deploy, ship by push. */
export const defaultManifest = (name: string): ProjectManifest =>
  ProjectManifest.parse({ apiVersion: MANIFEST_API_VERSION, name })

/** The targets of the make contract (design §9). */
export const MAKE_CONTRACT = [
  'check',
  'test',
  'deploy',
  'verify',
  'version',
  'restart',
  'quality',
  'logs',
  'status',
] as const
export type MakeTarget = (typeof MAKE_CONTRACT)[number]

/** Which contract targets a project's Makefile has; `makefile` is false when there is none (and then every target is). */
export const MakeTargets = z.object({
  makefile: z.boolean(),
  check: z.boolean(),
  test: z.boolean(),
  deploy: z.boolean(),
  verify: z.boolean(),
  /** prints the deployed commit sha, one line: what the hold reads to know the shipped commits are deployed */
  version: z.boolean().default(false),
  restart: z.boolean(),
  quality: z.boolean(),
  logs: z.boolean(),
  status: z.boolean(),
})
export type MakeTargets = z.infer<typeof MakeTargets>

export const ProjectName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/, 'not a valid project name')

/** A manifest that did not parse: the content's hash (the upkeep Issue's key), why, and the Issue that was opened for it. */
export const ManifestError = z.object({
  sha: z.string(),
  message: z.string(),
  issue: z.number().int().nullable(),
})
export type ManifestError = z.infer<typeof ManifestError>

export const Project = z.object({
  /** the directory's name (`<name>~<hash>` for a second directory of that name) */
  name: ProjectName,
  repo: z.string(),
  /** `manifest`: the last valid `project.yaml`; `defaults`: there is none (or never was) */
  source: z.enum(['manifest', 'defaults']),
  /** the manifest in force, defaults filled in */
  manifest: ProjectManifest,
  manifestSha: z.string().nullable(),
  /** the content now on the default branch does not parse; `manifest` is the last valid one */
  manifestError: ManifestError.nullable(),
  makeTargets: MakeTargets.nullable(),
  /** who holds the project's claim (`repo:<name>`) and who waits for it, by Issue id */
  claim: z.object({ leads: z.number().int(), holders: z.array(z.number().int()), queued: z.array(z.number().int()) }),
  paused: z.boolean(),
  syncedAt: z.string().nullable(),
  /** `docs/plan.yaml` (design §4 "The plan files its next Issue"): its rows with their state; null: no plan, or not read for this response */
  plan: PlanView.nullable().default(null),
  /** the content now on the default branch does not parse; `plan` is the last valid one */
  planError: z.string().nullable().default(null),
})
export type Project = z.infer<typeof Project>

export const ProjectList = z.object({ projects: z.array(Project) })
export type ProjectList = z.infer<typeof ProjectList>

/** `POST /projects/sync`: how many projects were read, and which manifests are broken (with the Issue each one opened). */
export const ProjectSyncResult = z.object({
  synced: z.number().int(),
  broken: z.array(z.object({ project: z.string(), issue: z.number().int().nullable() })),
  /** repos that could not be read this time; their rows are left as they were */
  errors: z.array(z.string()),
})
export type ProjectSyncResult = z.infer<typeof ProjectSyncResult>
