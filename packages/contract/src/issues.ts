import * as z from 'zod'
import { LaneName } from './lane.ts'
import { QualityIssue } from './quality.ts'
import { SeatInput } from './seat.ts'

/** Marks a string as an Issue id for the CLI (help, and `12` written as `issue_12` before it is sent); no validation. */
export const ISSUE_ID_META = { description: 'an Issue id', 'x-id': 'issue' } as const

/** `issue_12` or the bare `12`: every Issue a client names in a body takes both. */
export const IssueRefInput = z
  .string()
  .regex(/^(issue_)?[1-9][0-9]*$/, 'an Issue is issue_<n> or <n>')
  .meta(ISSUE_ID_META)

const Call = z.string().trim().min(1).max(128)
/** the longest `text` an Issue is filed with */
export const NEW_ISSUE_TEXT_MAX = 20_000
const Text = z.string().trim().min(1).max(NEW_ISSUE_TEXT_MAX)

/**
 * `issue new`: the owner files an Issue. `repo` is an absolute path inside a configured source root or a repo's directory
 * name; the server resolves it (422 `repo_outside_roots`). The same `key` again files nothing and answers `filed: false`.
 */
export const NewIssueBody = z
  .strictObject({
    repo: z.string().trim().min(1).max(1024),
    title: z.string().trim().min(1).max(512),
    /** what the lead is told besides the title: a JSON object of named facts */
    facts: z.record(z.string(), z.unknown()).optional(),
    /** the lead's tier and effort: `{tier, effort}` or `{role}`; checked by the server (422 `seat_refused`, naming the field) */
    seat: SeatInput.optional(),
    /** the resource class it runs in; the repo's `project.yaml` `lanes:` caps how many leads of a lane run at once */
    lane: LaneName.optional(),
    text: Text.optional(),
    key: z.string().trim().min(1).max(200).optional(),
    /** `request` is a person's ask; `alert` is something that broke */
    source: z.enum(['request', 'alert']).optional(),
    after: z.array(IssueRefInput).max(20).optional(),
    /** the Issue waits for nothing; like `after`, this states its edges and settling adds none */
    alone: z.boolean().optional(),
  })
  .meta({ id: 'NewIssueBody' })
export type NewIssueBody = z.infer<typeof NewIssueBody>

export const NewIssueAnswer = z
  .object({ issue: z.string(), state: z.string(), filed: z.boolean() })
  .meta({ id: 'NewIssueAnswer' })
export type NewIssueAnswer = z.infer<typeof NewIssueAnswer>

/** `issue cancel`: the owner ends an Issue; the machine finalizes its lead, worktree and claim. */
export const CancelBody = z
  .strictObject({ reason: z.string().trim().min(1).max(4_000), call: Call.optional() })
  .meta({ id: 'CancelBody' })
export type CancelBody = z.infer<typeof CancelBody>

/** The orchestrator steering a lead on the owner's token: not an owner touch. */
const Via = z.enum(['orchestrator'])

/** `issue note`: the owner's words for the lead. With `wake`, a wait the owner may end is ended too. */
export const NoteBody = z
  .strictObject({ text: Text, wake: z.boolean().optional(), call: Call.optional(), via: Via.optional() })
  .meta({ id: 'NoteBody' })
export type NoteBody = z.infer<typeof NoteBody>

/** What a note did: `woken` is false with the machine's reason in `detail` when the wake was refused; the note stays. */
export const NoteAnswer = z
  .object({
    noted: z.boolean(),
    woken: z.boolean(),
    detail: z.string().nullable(),
    issue: QualityIssue,
  })
  .meta({ id: 'NoteAnswer' })
export type NoteAnswer = z.infer<typeof NoteAnswer>

/**
 * `issue answer`: the legacy form for an Issue's open Decision. Iris sends `{id: callId, answer}`: `id` is the older
 * name of `call`, and a body property `id` would be a second `--id` beside the path's, so the body is loose (an unknown
 * key is accepted, not documented) instead of declaring it. An answer is idempotent by its Decision, so `call` changes nothing.
 */
export const IssueAnswerBody = z
  .looseObject({
    answer: Text,
    decision: z.string().trim().min(1).max(128).optional(),
    call: Call.optional(),
  })
  .meta({ id: 'IssueAnswerBody' })
export type IssueAnswerBody = z.infer<typeof IssueAnswerBody>

/** `session note`: a note typed to a lead by its session key. `id` is the legacy name of `call`. */
export const SessionNoteBody = z
  .strictObject({ text: Text, call: Call.optional(), id: Call.optional(), via: Via.optional() })
  .meta({ id: 'SessionNoteBody' })
export type SessionNoteBody = z.infer<typeof SessionNoteBody>
