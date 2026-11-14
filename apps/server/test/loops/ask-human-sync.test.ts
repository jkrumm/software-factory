import { describe, expect, test } from 'bun:test'
import { askHumanSync } from '../../src/adapters/shell/ask-human.ts'

describe('the MacBook sync verb', () => {
  test('runs dotfiles-sync with no arguments through the MacBook alias, in batch mode', async () => {
    const calls: string[][] = []
    const port = askHumanSync({
      host: 'macbook-alias',
      run: (cmd) => {
        calls.push(cmd)
        return Promise.resolve({ exitCode: 0, stdout: 'level' })
      },
    })
    const answer = await port.sync()
    expect(answer).toEqual({ ok: true, value: { exit: 0, output: 'level' } })
    expect(calls).toEqual([['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'macbook-alias', 'dotfiles-sync']])
  })

  test('answers the exit code as it came, and a missing alias or a failed start as a port error', async () => {
    const down = askHumanSync({ host: 'h', run: () => Promise.resolve({ exitCode: 255, stdout: '' }) })
    expect(await down.sync()).toEqual({ ok: true, value: { exit: 255, output: '' } })
    expect((await askHumanSync({ host: null }).sync()).ok).toBe(false)
    const broken = askHumanSync({ host: 'h', run: () => Promise.reject(new Error('no ssh')) })
    expect((await broken.sync()).ok).toBe(false)
  })
})
