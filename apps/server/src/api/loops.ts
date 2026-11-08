import { ErrorBody, LOOP_NAMES, LoopList, LoopRunReply, type LoopName, type LoopView } from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import { errorResponses } from './errors.ts'

/** The loop runner as the routes see it. */
export interface LoopsApi {
  view(): LoopView[]
  runNow(name: LoopName): Promise<{ started: boolean; summary: string | null; error: string | null } | null>
}

const Name = z.object({ name: z.string() })

const failure = (status: number, error: string, code: string): Response =>
  Response.json(ErrorBody.parse({ error, code }), { status })

const isLoop = (name: string): name is LoopName => (LOOP_NAMES as readonly string[]).includes(name)

/**
 * The loops, shown, and one pass of one on demand: how the scenarios drive time, and how the owner asks the steward to look
 * now. Unbound (the OpenAPI document alone), the routes answer 503.
 */
export const loopRoutes = (loops: LoopsApi | undefined) =>
  new Elysia({ prefix: '/v1' })
    .get(
      '/loops',
      () =>
        loops
          ? Response.json(LoopList.parse({ loops: loops.view() }))
          : failure(503, 'the loops are not wired in this process', 'unavailable'),
      {
        response: { 200: LoopList, ...errorResponses(503) },
        detail: {
          operationId: 'loop.list',
          summary: 'every loop: its interval, what it ran, when it last ended ok, and the kicks the loop guard dropped',
        },
      },
    )
    .post(
      '/loops/:name/run',
      async ({ params }) => {
        if (!loops) return failure(503, 'the loops are not wired in this process', 'unavailable')
        if (!isLoop(params.name)) return failure(404, `no loop ${params.name}`, 'not_found')
        const ran = await loops.runNow(params.name)
        if (!ran) return failure(404, `no loop ${params.name}`, 'not_found')
        const loop = loops.view().find((view) => view.name === params.name)
        return Response.json(LoopRunReply.parse({ loop, ...ran }))
      },
      {
        params: Name,
        response: { 200: LoopRunReply, ...errorResponses(404, 503) },
        detail: {
          operationId: 'loop.run',
          summary:
            'one pass of one loop now (leads, planning, watch, settle, send, steward, triage, queue, friction, hygiene); a pass already running is waited for, not started again',
        },
      },
    )
