import { describe, expect, test } from 'bun:test'
import { resolveSeat } from '../src/app/seat.ts'
import { ok } from '../src/kernel/result.ts'

const roles = { role: async () => ok({ tier: 'haiku' as const, effort: 'high' as const }) }

describe('resolveSeat', () => {
  test('keeps moveUp beside a role and beside tier and effort', async () => {
    expect(await resolveSeat(roles, { role: 'light', moveUp: true })).toEqual(
      ok({ tier: 'haiku', effort: 'high', role: 'light', moveUp: true }),
    )
    expect(await resolveSeat(roles, { tier: 'opus', effort: 'high', moveUp: true })).toEqual(
      ok({ tier: 'opus', effort: 'high', moveUp: true }),
    )
  })

  test('a seat without moveUp stores none', async () => {
    expect(await resolveSeat(roles, { role: 'light' })).toEqual(ok({ tier: 'haiku', effort: 'high', role: 'light' }))
  })
})
