import { expect, test } from 'bun:test'
import { parseRemote } from '../../src/adapters/intake/github.ts'

test('an origin on github.com is owner/name over https, with or without a user part, and over ssh', () => {
  const want = { owner: 'o', name: 'r' }
  expect(parseRemote('https://github.com/o/r.git')).toEqual(want)
  expect(parseRemote('https://github.com/o/r')).toEqual(want)
  expect(parseRemote('https://someone@github.com/o/r.git')).toEqual(want)
  expect(parseRemote('https://someone:secret@github.com/o/r')).toEqual(want)
  expect(parseRemote('git@github.com:o/r.git')).toEqual(want)
})

test('a host that only looks like github.com is not one', () => {
  expect(parseRemote('https://github.com.evil.example/o/r.git')).toBeUndefined()
  expect(parseRemote('https://evil@github.com.evil.example/o/r.git')).toBeUndefined()
  expect(parseRemote('https://x@gitlab.com/o/r.git')).toBeUndefined()
  expect(parseRemote('https://github.com/../x')).toBeUndefined()
})
