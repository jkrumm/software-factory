import { z } from 'zod'

export const EVENT_KINDS = ['session_started', 'turn_started', 'turn_ended', 'limit_stop', 'session_ended'] as const

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

export const SpawnInput = z.object({
  key: SpawnKey,
  repo: RepoPath,
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
})
export type SpawnInput = z.infer<typeof SpawnInput>

export const CapacityInput = z.object({
  weeklyUsed: z.number().min(0),
  fiveHourUsed: z.number().min(0),
  resetsAt: timestamp,
})
export type CapacityInput = z.infer<typeof CapacityInput>

/** stdout of `HERDR_BIN tab create` */
export const HerdrTabOutput = z.object({ pane: nonEmpty })
