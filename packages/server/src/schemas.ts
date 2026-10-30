import { EVENT_KINDS, QueueState, RoleName, WaitOn } from '@software-factory/contract'
import { z } from 'zod'

export { EVENT_KINDS }

/** Both sit well inside the server's 64 KiB body cap. */
export const MAX_PROMPT_CHARS = 32_000
export const MAX_PAYLOAD_CHARS = 16_000

const timestamp = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
const nonEmpty = z.string().min(1).max(256)

/** An account name is a path segment in the API and a key in the queue: a short token, never free text. */
export const AccountName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'not a valid account name')

export const EventInput = z.object({
  key: nonEmpty,
  session: nonEmpty,
  kind: z.enum(EVENT_KINDS),
  at: timestamp,
  payload: z
    .record(z.string(), z.unknown())
    .refine(
      (p) => JSON.stringify(p).length <= MAX_PAYLOAD_CHARS,
      `payload is larger than ${MAX_PAYLOAD_CHARS} characters`,
    )
    .optional(),
})
export type EventInput = z.infer<typeof EventInput>

/** The key becomes a herdr tab name on a command line: a token that cannot read as a flag. */
const SpawnKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'not a valid spawn key')
/** The repo becomes `--cwd`: an absolute path. */
const RepoPath = z
  .string()
  .max(1024)
  .regex(/^\/[^\0]*$/, 'not an absolute path')

/** What a spawn is started as when the caller says nothing. */
export const DEFAULT_ROLE = 'worker'

export const SpawnInput = z.object({
  key: SpawnKey,
  repo: RepoPath,
  role: RoleName.default(DEFAULT_ROLE),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .refine((p) => !p.startsWith('-'), "a prompt cannot start with '-': herdr would read it as an option"),
})
export type SpawnInput = z.infer<typeof SpawnInput>

/**
 * One account's quota reading: what `claude-account usage --json` says, or what a test or an operator injects.
 * Percentages are of the window; null means the picker has no sample. `ageS` is the age of the sample behind it.
 */
export const QuotaInput = z.object({
  enabled: z.boolean().default(true),
  authOk: z.boolean().default(true),
  fiveHourUsed: z.number().min(0).nullable(),
  weeklyUsed: z.number().min(0).nullable(),
  fiveHourResetsAt: timestamp.nullable().default(null),
  weeklyResetsAt: timestamp.nullable().default(null),
  exhaustedUntil: timestamp.nullable().default(null),
  ageS: z.number().min(0).nullable().default(0),
})
export type QuotaInput = z.output<typeof QuotaInput>

/** `PUT /queue`: the state of the global scope, or of one project. */
export const QueueInput = z.object({
  state: QueueState,
  project: RepoPath.optional(),
})
export type QueueInput = z.infer<typeof QueueInput>

/** `factory session wait --on …` declares a wait, `--done` closes it. */
export const WaitInput = z.union([z.strictObject({ on: WaitOn }), z.strictObject({ done: z.literal(true) })])
export type WaitInput = z.infer<typeof WaitInput>
