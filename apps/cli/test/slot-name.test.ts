import { expect, test } from 'bun:test'
import { unnamedStep } from '../src/slot.ts'

test('an unnamed make step is named after its targets, any other program after itself', () => {
  expect(unnamedStep('make', ['check-fast'])).toBe('make check-fast')
  expect(unnamedStep('/usr/bin/make', ['-B', '-C', '/src/p', '-j', '4', 'e2e', 'CI=1'])).toBe('make e2e')
  expect(unnamedStep('make', ['lint', 'test'])).toBe('make lint+test')
  expect(unnamedStep('make', ['-j8'])).toBe('make')
  expect(unnamedStep('make', ['-sC', 'dir', '--jobs', '4', 'e2e'])).toBe('make e2e')
  expect(unnamedStep('bun', ['test'])).toBe('bun')
})
