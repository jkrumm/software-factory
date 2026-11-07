import * as z from 'zod'

/**
 * Every answer that is not a success: the message for a person and a stable code for a program. `details` carries the
 * fields of a refusal when it has some: `fields` (the names of the missing or invalid fields of a form), `path` (the
 * Issue ids of a cycle, in order).
 */
export const ErrorBody = z
  .object({
    error: z.string(),
    code: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'ErrorBody' })
export type ErrorBody = z.infer<typeof ErrorBody>
