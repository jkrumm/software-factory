import * as z from 'zod'

/** A lane is a resource inside a repo (`apple`, `db`): lowercase letters, digits and dashes. */
export const LaneName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a lane name like `apple`: lowercase letters, digits, dashes, at most 40')
  .meta({ id: 'LaneName' })
export type LaneName = z.infer<typeof LaneName>

/**
 * A checkpoint is a gate the filer puts on an Issue before its lead builds. `spec`: the lead owes a one-page Spec
 * (at most three open choices, each with its default) and the ship is refused without one; the owner's verdict ends the wait,
 * and with none the lead goes on with its defaults after `SPEC_WAIT_HOURS`. `gate`: the same Spec is owed, but only the
 * owner's own verdict ends the wait: no default, no Spec screen settle, so what is `after` the Issue is released by him alone.
 * Only a filer sets it (never triage).
 */
export const CheckpointName = z.enum(['spec', 'gate']).meta({ id: 'CheckpointName' })
export type CheckpointName = z.infer<typeof CheckpointName>

/** How long a Concept or Spec waits for the owner's verdict before the lead takes its own defaults. */
export const SPEC_WAIT_HOURS = 24
