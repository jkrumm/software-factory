import { describe, expect, test } from 'bun:test'
import { resolveSeat } from '../src/app/seat.ts'
import { err, ok, portError } from '../src/kernel/result.ts'

const table = {
  light: { tier: 'haiku', effort: 'high' },
  lead: { tier: 'sonnet', effort: 'high' },
  strong: { tier: 'opus', effort: 'high' },
} as const
const roles = {
  role: async (name: string) => {
    const row = table[name as keyof typeof table]
    return row ? ok({ ...row }) : err(portError('refused', `no role ${name}`))
  },
}
const hand = { requireWhy: true }
const field = (result: Awaited<ReturnType<typeof resolveSeat>>) =>
  result.ok ? null : 'field' in result.error ? result.error.field : result.error.kind

describe('resolveSeat', () => {
  test('keeps moveUp beside a role and beside tier and effort', async () => {
    expect(await resolveSeat(roles, { role: 'light', moveUp: true })).toEqual(
      ok({ tier: 'haiku', effort: 'high', role: 'light', moveUp: true }),
    )
    expect(await resolveSeat(roles, { tier: 'haiku', effort: 'high', moveUp: true })).toEqual(
      ok({ tier: 'haiku', effort: 'high', moveUp: true }),
    )
  })

  test('a seat without moveUp stores none', async () => {
    expect(await resolveSeat(roles, { role: 'light' })).toEqual(ok({ tier: 'haiku', effort: 'high', role: 'light' }))
  })

  test('the lead row with moveUp is stored as the lead row, whether named by role or by tier and effort', async () => {
    const stored = ok({ tier: 'sonnet' as const, effort: 'high' as const, role: 'lead', moveUp: true as const })
    expect(await resolveSeat(roles, { role: 'lead', moveUp: true }, hand)).toEqual(stored)
    expect(await resolveSeat(roles, { tier: 'sonnet', effort: 'high', moveUp: true }, hand)).toEqual(stored)
  })

  test('a tier above the lead row needs a why on the hand verbs, and the refusal names the alternative', async () => {
    const refused = await resolveSeat(roles, { tier: 'opus', effort: 'high' }, hand)
    expect(field(refused)).toBe('seat.why')
    expect(!refused.ok && 'detail' in refused.error ? refused.error.detail : '').toContain(
      '{"role":"lead","moveUp":true}',
    )
    expect(field(await resolveSeat(roles, { role: 'strong' }, hand))).toBe('seat.why')
    expect(await resolveSeat(roles, { tier: 'opus', effort: 'high', why: 'a schema others build on' }, hand)).toEqual(
      ok({ tier: 'opus', effort: 'high', why: 'a schema others build on' }),
    )
  })

  test('a plan row is not refused for the missing why, and the lead row and below never need one', async () => {
    expect(await resolveSeat(roles, { tier: 'opus', effort: 'high' })).toEqual(ok({ tier: 'opus', effort: 'high' }))
    expect(await resolveSeat(roles, { tier: 'sonnet', effort: 'max' }, hand)).toEqual(
      ok({ tier: 'sonnet', effort: 'max' }),
    )
    expect(await resolveSeat(roles, { role: 'light' }, hand)).toEqual(
      ok({ tier: 'haiku', effort: 'high', role: 'light' }),
    )
  })

  test('a seat above the lead row has no row to move up to', async () => {
    const refused = await resolveSeat(roles, { tier: 'opus', effort: 'high', moveUp: true, why: 'hard' }, hand)
    expect(field(refused)).toBe('seat.moveUp')
    expect(field(await resolveSeat(roles, { role: 'strong', moveUp: true }))).toBe('seat.moveUp')
  })

  test('a table without the lead row leaves the seat as given', async () => {
    const bare = { role: async () => err(portError('refused', 'no such role')) }
    expect(await resolveSeat(bare, { tier: 'opus', effort: 'high' }, hand)).toEqual(
      ok({ tier: 'opus', effort: 'high' }),
    )
  })
})
