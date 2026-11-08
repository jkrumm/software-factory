import { expect, test } from 'bun:test'
import { ageWords } from '../src/lib/age.ts'

const MIN = 60_000

test('ageWords names the age in plain words', () => {
  expect(ageWords(0)).toBe('just now')
  expect(ageWords(59_999)).toBe('just now')
  expect(ageWords(MIN)).toBe('1 min ago')
  expect(ageWords(4 * MIN + 30_000)).toBe('4 min ago')
  expect(ageWords(60 * MIN)).toBe('1 h ago')
  expect(ageWords(3 * 60 * MIN)).toBe('3 h ago')
  expect(ageWords(24 * 60 * MIN)).toBe('1 d ago')
  expect(ageWords(2 * 24 * 60 * MIN + 5 * MIN)).toBe('2 d ago')
})
