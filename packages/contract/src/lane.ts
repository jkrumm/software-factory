import * as z from 'zod'

/** A lane is a resource class inside a repo (`apple`, `db`): lowercase letters, digits and dashes. */
export const LaneName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a lane name like `apple`: lowercase letters, digits, dashes, at most 40')
  .meta({ id: 'LaneName' })
export type LaneName = z.infer<typeof LaneName>
