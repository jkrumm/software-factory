import { describe, expect, test } from 'bun:test'
import { moveSignOf } from '../src/move-sign.ts'

describe('moveSignOf', () => {
  test('reads the light lead’s wording of each sign', () => {
    expect(moveSignOf('the light lead said the work is beyond its seat')).toBe('outOfDepth')
    expect(moveSignOf('the light lead’s change regressed on its first watch')).toBe('regressed')
    expect(moveSignOf('the light lead stalled 2 times')).toBe('stalled')
    expect(moveSignOf('the light lead’s ship was refused 3 times')).toBe('refusedShips')
  })

  test('reads the lead row’s wording of each sign', () => {
    expect(moveSignOf('the lead said the work is beyond its seat')).toBe('outOfDepth')
    expect(moveSignOf('the lead’s change regressed on its first watch')).toBe('regressed')
    expect(moveSignOf('the lead stalled 2 times')).toBe('stalled')
    expect(moveSignOf('the lead’s ship was refused 2 times')).toBe('refusedShips')
  })

  test('reads past the detail a move-up appends after a colon', () => {
    expect(moveSignOf('the lead stalled 2 times: the same test fails again')).toBe('stalled')
    expect(moveSignOf('the light lead said the work is beyond its seat: the parser is out of reach')).toBe('outOfDepth')
  })

  test('is null for any other text', () => {
    expect(moveSignOf('')).toBeNull()
    expect(moveSignOf('beyond its seat')).toBeNull()
    expect(moveSignOf('the light lead stalled times')).toBeNull()
    expect(moveSignOf('the lead stalled 2 times it did not')).toBeNull()
    expect(moveSignOf('the light lead’s change regressed on its first watch.')).toBeNull()
    expect(moveSignOf("the light lead's change regressed on its first watch")).toBeNull()
    expect(moveSignOf('the beyond its seat')).toBeNull()
  })
})
