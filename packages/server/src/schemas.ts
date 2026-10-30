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

/** What only the witness may say about herdr: a hook (or anything on the open socket) cannot report a restart or a gone pane. */
const WITNESS_KINDS: readonly string[] = ['herdr_restarted', 'pane_gone']

export const EventInput = z
  .object({
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
  .refine((e) => !WITNESS_KINDS.includes(e.kind) && e.session !== '_herdr', {
    message: "herdr_restarted and pane_gone are the witness's to record, not a hook's",
    path: ['kind'],
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
  /** the `FACTORY_SESSION` of the caller: the session this one is a worker of */
  parent: z.string().min(1).max(256).optional(),
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
export const QueueInput = z.strictObject({
  state: QueueState,
  project: RepoPath.optional(),
})
export type QueueInput = z.infer<typeof QueueInput>

/** `factory session wait --on …` declares a wait, `--done` closes it. */
export const WaitInput = z.union([z.strictObject({ on: WaitOn }), z.strictObject({ done: z.literal(true) })])
export type WaitInput = z.infer<typeof WaitInput>

const RULE_PREFIXES = /^(resume|rotate|blocked|restart):/

/** `factory session note`: `id` makes a repeated call one prompt; a caller that wants every call to count leaves it out. */
export const NoteInput = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/, 'not a valid prompt id')
    // A rule's prompt is keyed `<rule>:...`: a note under such an id would take its place and keep the rule from firing.
    .refine(
      (id) => !RULE_PREFIXES.test(id),
      'ids starting with a rule name (resume, rotate, blocked, restart) are reserved',
    ),
  text: z
    .string()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .refine((p) => !p.startsWith('-'), "a note cannot start with '-': herdr would read it as an option"),
})
export type NoteInput = z.infer<typeof NoteInput>

/** What the `Stop` hook tells the server about the stop it is asking on behalf of. */
export const StopCheckInput = z.object({ stopHookActive: z.boolean().default(false) })
