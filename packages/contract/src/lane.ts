import * as z from 'zod'

/** A lane is a resource inside a repo (`apple`, `db`): lowercase letters, digits and dashes. */
export const LaneName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a lane name like `apple`: lowercase letters, digits, dashes, at most 40')
  .meta({ id: 'LaneName' })
export type LaneName = z.infer<typeof LaneName>

/**
 * A checkpoint is what the filer puts on an Issue before its lead builds. `spec`: the lead writes its plan first, as a Spec
 * (Build, then Decided), and the ship is refused without one; nobody waits on it. `gate`: the same Spec is owed, and it is
 * the one way a filer makes the owner read: only his own verdict ends the wait, no default, no rule settles it, so what is
 * `after` the Issue is released by him alone.
 * Only a filer sets it (never triage).
 */
export const CheckpointName = z.enum(['spec', 'gate']).meta({ id: 'CheckpointName' })
export type CheckpointName = z.infer<typeof CheckpointName>

/**
 * How long a Concept, a filed Spec, a Replan or a revision after Changes waits for the owner's verdict before the lead takes
 * its own defaults. A gate has no default; a lead's Spec does not wait at all.
 */
export const SPEC_WAIT_HOURS = 24
