import * as z from 'zod'

/**
 * The internal test route's bodies (`/internal/test/...`): the narrow entry the scenarios use to record events on an
 * Issue until package 8 brings the API. Off unless `FACTORY_INTERNAL_TEST_ROUTES=1`; package 8 deletes this file.
 */
export const InternalTestEventBody = z
  .object({
    key: z.string().min(1),
    kind: z.string().min(1),
    payload: z.unknown(),
    actor: z.enum(['owner', 'lead', 'factory', 'steward', 'judge']),
  })
  .meta({ id: 'InternalTestEventBody' })
export type InternalTestEventBody = z.infer<typeof InternalTestEventBody>

export const InternalTestEventAnswer = z
  .object({
    result: z.enum(['applied', 'refused', 'ignored', 'replayed']),
    detail: z.string().nullable(),
    issue: z.object({
      id: z.string(),
      state: z.string(),
      waitReason: z.string().nullable(),
      outcome: z.string().nullable(),
      version: z.number().int(),
    }),
    event: z.object({ id: z.string(), key: z.string(), version: z.number().int().nullable() }),
    effects: z.array(z.object({ kind: z.string(), key: z.string() })),
  })
  .meta({ id: 'InternalTestEventAnswer' })
export type InternalTestEventAnswer = z.infer<typeof InternalTestEventAnswer>
