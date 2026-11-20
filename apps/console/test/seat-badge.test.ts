import { describe, expect, test } from 'bun:test'
import type { LeadSeat } from '@software-factory/contract'
import { seatCode, seatWords } from '../src/components/kit/seat-badge.tsx'

const seat = (
  tier: LeadSeat['tier'],
  effort: LeadSeat['effort'],
  role: string | null = 'lead',
  planned = false,
  rule: string | null = null,
  sizeKnown = true,
): LeadSeat => ({
  tier,
  effort,
  role,
  planned,
  rule,
  sizeKnown,
})

describe('seatCode', () => {
  test('is the tier letter and the effort letter, XX for max', () => {
    expect(seatCode(seat('haiku', 'high'))).toBe('HH')
    expect(seatCode(seat('sonnet', 'high'))).toBe('SH')
    expect(seatCode(seat('sonnet', 'medium'))).toBe('SM')
    expect(seatCode(seat('opus', 'low'))).toBe('OL')
    expect(seatCode(seat('opus', 'xhigh'))).toBe('OX')
    expect(seatCode(seat('opus', 'max'))).toBe('OXX')
  })
})

describe('seatWords', () => {
  test('spells the seat out with its role', () => {
    expect(seatWords(seat('haiku', 'high'))).toBe('Haiku, high effort — lead role')
    expect(seatWords(seat('opus', 'xhigh', 'light'))).toBe('Opus, extra-high effort — light role')
  })

  test('leaves the role out when none is known, and says a planned seat is not started on yet', () => {
    expect(seatWords(seat('sonnet', 'medium', null))).toBe('Sonnet, medium effort')
    expect(seatWords(seat('haiku', 'high', 'lead', true))).toBe('Will start on Haiku, high effort — lead role')
  })

  test('names the light rule, and says a planned seat still waits for the size', () => {
    expect(seatWords(seat('haiku', 'high', 'light', true, 'triage:small'))).toBe(
      'Will start on Haiku, high effort — light role (rule triage:small)',
    )
    expect(seatWords(seat('sonnet', 'high', 'lead', true, null, false))).toBe(
      'Will start on Sonnet, high effort — lead role; size not known yet, it may still start light',
    )
  })
})
