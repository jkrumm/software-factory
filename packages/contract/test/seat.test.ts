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

  test('takes a why of one line up to 300 characters, beside either form', () => {
    expect(parseSeat({ tier: 'opus', effort: 'high', why: ' a design later Issues build on ' })).toEqual({
      ok: true,
      seat: { tier: 'opus', effort: 'high', why: 'a design later Issues build on' },
    })
    expect(parseSeat({ role: 'strong', moveUp: false, why: 'x' })).toEqual({
      ok: true,
      seat: { role: 'strong', why: 'x' },
    })
    const why = (value: unknown) => {
      const parsed = parseSeat({ role: 'strong', why: value })
      return parsed.ok ? null : parsed.field
    }
    expect(why('x'.repeat(300))).toBeNull()
    expect(why('x'.repeat(301))).toBe('seat.why')
    expect(why('')).toBe('seat.why')
    expect(why('  ')).toBe('seat.why')
    expect(why(7)).toBe('seat.why')
    expect(why('two\nlines')).toBe('seat.why')
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
