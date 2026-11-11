import { expect, test } from 'bun:test'
import { isPlainClick, peekOf, peekSearch, peekTarget } from '../src/lib/peek'

const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }

test('a peek reads from the search and writes back to it', () => {
  expect(peekOf({})).toBeNull()
  expect(peekOf({ peek: 'issues/12' })).toEqual({ kind: 'issue', id: '12' })
  expect(peekOf({ peek: 'issues/12', peekTab: 'activity' })).toEqual({ kind: 'issue', id: '12', tab: 'activity' })
  expect(peekOf({ peek: 'artifacts/art_1', peekRevision: '2' })).toEqual({ kind: 'artifact', id: 'art_1', revision: 2 })
  expect(peekSearch({ kind: 'issue', id: '12', tab: 'evidence' })).toEqual({
    peek: 'issues/12',
    peekTab: 'evidence',
    peekRevision: undefined,
  })
  expect(peekSearch(null)).toEqual({ peek: undefined, peekTab: undefined, peekRevision: undefined })
})

test('a value that names nothing shows nothing', () => {
  for (const peek of ['issues/', 'issues/abc', 'issues', 'nothing/1', 'artifacts/', 42]) {
    expect(peekOf({ peek })).toBeNull()
  }
  expect(peekOf({ peek: 'issues/3', peekTab: 'overview' })).toEqual({ kind: 'issue', id: '3' })
  expect(peekOf({ peek: 'artifacts/a', peekRevision: '0' })).toEqual({ kind: 'artifact', id: 'a' })
})

test('a link to an Issue or an artifact stands for a peek, any other does not', () => {
  const none = new URLSearchParams()
  expect(peekTarget('/issues/12', none)).toEqual({ kind: 'issue', id: '12' })
  expect(peekTarget('/issues/12/', none)).toEqual({ kind: 'issue', id: '12' })
  expect(peekTarget('/issues/12', new URLSearchParams('tab=checkpoints'))).toEqual({
    kind: 'issue',
    id: '12',
    tab: 'checkpoints',
  })
  expect(peekTarget('/artifacts/x', new URLSearchParams('revision=3'))).toEqual({
    kind: 'artifact',
    id: 'x',
    revision: 3,
  })
  expect(peekTarget('/artifacts/x', new URLSearchParams('revision=2&compare=1'))).toBeNull()
  for (const path of ['/flow', '/issues', '/issues/12/extra', '/chain', '/needs-you', '/']) {
    expect(peekTarget(path, none)).toBeNull()
  }
})

test('only a plain primary click opens the peek', () => {
  expect(isPlainClick(click)).toBe(true)
  for (const change of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    expect(isPlainClick({ ...click, ...change })).toBe(false)
  }
  expect(isPlainClick({ ...click, defaultPrevented: true })).toBe(false)
})
