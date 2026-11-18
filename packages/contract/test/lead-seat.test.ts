import { describe, expect, test } from 'bun:test'
import { ChainNode, FlowClosed, FlowIssue, LeadSeat, NeedItem, ReadIssueCard } from '../src/index.ts'

const seat: LeadSeat = { tier: 'sonnet', effort: 'high', role: 'lead', planned: false }

describe('LeadSeat', () => {
  test('takes a tier and effort of the table, a role or none, and whether it is planned', () => {
    expect(LeadSeat.parse(seat)).toEqual(seat)
    expect(LeadSeat.parse({ ...seat, role: null, planned: true }).planned).toBe(true)
  })

  test('refuses a model id, an unknown effort and a missing planned flag', () => {
    expect(LeadSeat.safeParse({ ...seat, tier: 'claude-sonnet-5-5' }).success).toBe(false)
    expect(LeadSeat.safeParse({ ...seat, effort: 'ultra' }).success).toBe(false)
    expect(LeadSeat.safeParse({ tier: 'opus', effort: 'low', role: null }).success).toBe(false)
    expect(LeadSeat.safeParse({ ...seat, model: 'x' }).success).toBe(false)
  })

  test('every read shape that shows an Issue next to its state carries it, nullable', () => {
    for (const shape of [
      ReadIssueCard.shape.leadSeat,
      ChainNode.shape.seat,
      FlowIssue.shape.seat,
      FlowClosed.shape.seat,
      NeedItem.shape.seat,
    ]) {
      expect(shape.safeParse(null).success).toBe(true)
      expect(shape.safeParse(seat).success).toBe(true)
      expect(shape.safeParse(undefined).success).toBe(false)
    }
  })
})
