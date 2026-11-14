import { expect, test } from 'bun:test'
import { askHumanPush } from '../../src/adapters/shell/ask-human.ts'

const run = (calls: string[][], exitCode: number) => (cmd: string[]) => {
  calls.push(cmd)
  return Promise.resolve({ exitCode, stdout: '' })
}

test('the probe asks the configured ssh alias the reachability verb, and says false when the MacBook does not answer', async () => {
  const calls: string[][] = []
  expect(await askHumanPush({ bin: null, home: '/h', host: 'macbook-alias', run: run(calls, 0) }).probe()).toBe(true)
  expect(calls[0]?.slice(-2)).toEqual(['macbook-alias', 'true'])
  expect(await askHumanPush({ bin: null, home: '/h', host: 'macbook-alias', run: run([], 255) }).probe()).toBe(false)
})

test('with no alias configured no probe runs', async () => {
  const calls: string[][] = []
  expect(await askHumanPush({ bin: null, home: '/h', host: null, run: run(calls, 0) }).probe()).toBe(false)
  expect(await askHumanPush({ bin: null, home: '/h', run: run(calls, 0) }).probe()).toBe(false)
  expect(calls).toEqual([])
})
