import { expect, test } from 'bun:test'
import { judgeMainCheckout } from '../../src/domains/loops/checkout.ts'

test('a clean checkout on the default branch is no finding', () => {
  expect(judgeMainCheckout({ branch: 'main', defaultBranch: 'main', dirty: [] })).toBeNull()
})

test('a checkout on another branch is a branch finding that names both branches and the owner escape', () => {
  const found = judgeMainCheckout({ branch: 'feature/x', defaultBranch: 'main', dirty: [] })
  expect(found).toMatchObject({ kind: 'branch', fingerprint: 'feature/x:clean' })
  expect(found?.text).toContain('feature/x')
  expect(found?.text).toContain('main')
  expect(found?.text).toContain('own worktree')
  expect(found?.text).toContain("owner's own work in progress, ignore this note")
})

test('a detached HEAD is off the branch when the default is known', () => {
  expect(judgeMainCheckout({ branch: null, defaultBranch: 'main', dirty: [] })).toMatchObject({
    kind: 'branch',
    fingerprint: 'detached:clean',
  })
})

test('tracked changes on the default branch are a dirty finding that names up to three paths', () => {
  const found = judgeMainCheckout({ branch: 'main', defaultBranch: 'main', dirty: ['a', 'b', 'c', 'd', 'e'] })
  expect(found).toMatchObject({ kind: 'dirty', fingerprint: 'main:dirty' })
  expect(found?.text).toContain('a, b, c, and 2 more')
  expect(found?.text).not.toContain('d,')
})

test('off the branch and dirty is both', () => {
  expect(judgeMainCheckout({ branch: 'x', defaultBranch: 'main', dirty: ['a'] })).toMatchObject({
    kind: 'both',
    fingerprint: 'x:dirty',
  })
})

test('an unknown default branch judges cleanliness only', () => {
  expect(judgeMainCheckout({ branch: 'x', defaultBranch: null, dirty: [] })).toBeNull()
  expect(judgeMainCheckout({ branch: 'x', defaultBranch: null, dirty: ['a'] })).toMatchObject({ kind: 'dirty' })
})

test('the fingerprint ignores which paths are dirty', () => {
  const one = judgeMainCheckout({ branch: 'main', defaultBranch: 'main', dirty: ['a'] })
  const other = judgeMainCheckout({ branch: 'main', defaultBranch: 'main', dirty: ['b', 'c'] })
  expect(one?.fingerprint).toBe(other?.fingerprint ?? '')
})
