import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DEPLOY_WAIT_MS, deployRunning, RESTART_WAIT_MS, restartPatience } from '../src/restart-wait.ts'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-restart-wait-')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('without a deploy the wait is 90 s; the first wait says so once on stderr', () => {
  const lines: string[] = []
  const patience = restartPatience({ FACTORY_DATA_DIR: join(dir, 'none') }, (text) => lines.push(text))
  expect(patience.limitMs()).toBe(RESTART_WAIT_MS)
  expect(RESTART_WAIT_MS).toBe(90_000)
  patience.onWait?.()
  expect(lines).toEqual(['server restarting (deploy), waiting\n'])
})

test('a deploy lock held by a live pid stretches the wait; a dead holder does not', async () => {
  const data = join(dir, 'data')
  await Bun.write(join(data, '.keep'), '')
  await symlink(String(process.pid), join(data, 'deploy.lock'))
  const env = { FACTORY_DATA_DIR: data }
  expect(deployRunning(env)).toBe(true)
  expect(restartPatience(env, () => {}).limitMs()).toBe(DEPLOY_WAIT_MS)
  await rm(join(data, 'deploy.lock'))
  await symlink('2147483646', join(data, 'deploy.lock'))
  expect(deployRunning(env)).toBe(false)
  expect(restartPatience(env, () => {}).limitMs()).toBe(RESTART_WAIT_MS)
})

test('FACTORY_RESTART_WAIT_MS sets the wait', () => {
  expect(
    restartPatience({ FACTORY_DATA_DIR: join(dir, 'none'), FACTORY_RESTART_WAIT_MS: '1500' }, () => {}).limitMs(),
  ).toBe(1500)
})
