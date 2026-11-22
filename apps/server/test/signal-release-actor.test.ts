import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/api/app.ts'
import { unwiredIntake } from '../src/api/intake.ts'
import { ok } from '../src/kernel/result.ts'

const TOKENS = {
  owner: 'owner-token-0123456789',
  orchestrator: 'orchestrator-token-0123456789',
  agent: 'agent-token-0123456789',
}

/** What the routes passed as `by`, per verb. */
function appWith() {
  const seen: { verb: string; by: unknown }[] = []
  const app = createApp({
    tokens: TOKENS,
    health: { read: () => Promise.reject(new Error('unused')) },
    log: () => {},
    intake: {
      ...unwiredIntake,
      promote: (_id, _body, by) => {
        seen.push({ verb: 'promote', by })
        return Promise.resolve(
          ok({ outcome: 'filed', detail: 'promoted', issue: 'issue_1', signal: 's1', reason: null } as never),
        )
      },
      dismiss: (_id, _body, by) => {
        seen.push({ verb: 'dismiss', by })
        return Promise.resolve(ok({ signal: 's1', state: 'dismissed' as const }))
      },
    },
  })
  const post = (path: string, token: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  return { seen, post }
}

describe('promote and dismiss record who released the signal', () => {
  test('the orchestrator token is recorded as orchestrator, the owner token as owner', async () => {
    const { seen, post } = appWith()
    expect((await post('/signals/s1/promote', TOKENS.orchestrator, { repo: 'argo' })).status).toBe(200)
    expect((await post('/signals/s1/dismiss', TOKENS.orchestrator, { reason: 'noise' })).status).toBe(200)
    expect((await post('/signals/s1/promote', TOKENS.owner, { repo: 'argo' })).status).toBe(200)
    expect((await post('/signals/s1/dismiss', TOKENS.owner, { reason: 'noise' })).status).toBe(200)
    expect(seen).toEqual([
      { verb: 'promote', by: 'orchestrator' },
      { verb: 'dismiss', by: 'orchestrator' },
      { verb: 'promote', by: 'owner' },
      { verb: 'dismiss', by: 'owner' },
    ])
  })

  test('a lead is refused and nothing is recorded', async () => {
    const { seen, post } = appWith()
    expect((await post('/signals/s1/promote', TOKENS.agent, { repo: 'argo' })).status).toBe(403)
    expect((await post('/signals/s1/dismiss', TOKENS.agent, { reason: 'noise' })).status).toBe(403)
    expect(seen).toEqual([])
  })
})
