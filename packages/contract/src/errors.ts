import * as z from 'zod'

/** Every answer that is not a success: the message for a person and a stable code for a program. */
export const ErrorBody = z
  .object({
    error: z.string(),
    code: z.string(),
  })
  .meta({ id: 'ErrorBody' })
export type ErrorBody = z.infer<typeof ErrorBody>
