import type { AgwPort, AgwResult } from '../../src/kernel/agw.ts'
import type { Key } from '../../src/kernel/keys.ts'
import { err, portError } from '../../src/kernel/result.ts'
import type { WorkflowName, WorkflowRequest } from '../../src/kernel/workflows.ts'

/** What a test answers one workflow with. */
export type Handler<N extends WorkflowName> = (
  request: WorkflowRequest<N>,
  key: Key,
) => AgwResult<N> | Promise<AgwResult<N>>

/**
 * The one fake agw port: each workflow the test scripts is answered by its handler, any other is a failed call (`gone`),
 * so a test never reaches a workflow it did not mean to.
 */
export function fakeAgw(handlers: { [N in WorkflowName]?: Handler<N> }): AgwPort {
  return {
    run: async (name, request, key) => {
      const handler = handlers[name]
      if (!handler) return err(portError('gone', `no fake answer for ${name}`))
      return handler(request, key)
    },
  }
}
