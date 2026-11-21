import { describe, expect, test } from 'bun:test'
import { parseSeat } from '../src/seat.ts'

describe('parseSeat', () => {
  test('takes tier and effort, or a role', () => {
    expect(parseSeat({ tier: 'opus', effort: 'high' })).toEqual({ ok: true, seat: { tier: 'opus', effort: 'high' } })
    expect(parseSeat({ role: 'lead' })).toEqual({ ok: true, seat: { role: 'lead' } })
  })

  test('takes moveUp beside either form and refuses a non-boolean', () => {
    expect(parseSeat({ role: 'light', moveUp: true })).toEqual({ ok: true, seat: { role: 'light', moveUp: true } })
    expect(parseSeat({ tier: 'haiku', effort: 'high', moveUp: true })).toEqual({
      ok: true,
      seat: { tier: 'haiku', effort: 'high', moveUp: true },
    })
    expect(parseSeat({ role: 'light', moveUp: false })).toEqual({ ok: true, seat: { role: 'light' } })
    const bad = parseSeat({ role: 'light', moveUp: 'yes' })
    expect(bad.ok ? null : bad.field).toBe('seat.moveUp')
    const alone = parseSeat({ moveUp: true })
    expect(alone.ok).toBe(false)
  })

  test('refuses what is not a seat, naming the field', () => {
    const field = (raw: unknown) => {
      const parsed = parseSeat(raw)
      return parsed.ok ? null : parsed.field
    }
    expect(field('opus')).toBe('seat')
    expect(field({})).toBe('seat')
    expect(field({ tier: 'gpt', effort: 'high' })).toBe('seat.tier')
    expect(field({ tier: 'claude-opus-5', effort: 'high' })).toBe('seat.tier')
    expect(field({ tier: 'opus', effort: 'ultra' })).toBe('seat.effort')
    expect(field({ tier: 'opus' })).toBe('seat.effort')
    expect(field({ effort: 'high' })).toBe('seat.tier')
    expect(field({ role: 'not a role' })).toBe('seat.role')
    expect(field({ role: 'lead', tier: 'opus' })).toBe('seat')
    expect(field({ tier: 'opus', effort: 'high', model: 'x' })).toBe('seat.model')
  })
})
