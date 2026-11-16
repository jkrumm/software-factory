import { describe, expect, test } from 'bun:test'
import { askHumanSync, askHumanVerbs } from '../../src/adapters/shell/ask-human.ts'

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

describe('the MacBook fixed verbs', () => {
  test('the verb and its one name go over the same ssh alias, in batch mode', async () => {
    const calls: string[][] = []
    const port = askHumanVerbs({
      host: 'macbook-alias',
      run: (cmd) => {
        calls.push(cmd)
        return Promise.resolve({ exitCode: 0, stdout: 'out' })
      },
    })
    expect(await port.run({ verb: 'report', name: 'smb-mounts' })).toEqual({
      ok: true,
      value: { exit: 0, output: 'out' },
    })
    await port.run({ verb: 'repo-pull', name: 'brain' })
    await port.run({ verb: 'dotfiles-sync' })
    const head = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'macbook-alias']
    expect(calls).toEqual([
      [...head, 'report', 'smb-mounts'],
      [...head, 'repo-pull', 'brain'],
      [...head, 'dotfiles-sync'],
    ])
  })

  test('the exit code comes as it is; no alias or a failed start is a port error', async () => {
    const down = askHumanVerbs({ host: 'h', run: () => Promise.resolve({ exitCode: 126, stdout: '' }) })
    expect(await down.run({ verb: 'report', name: 'x' })).toEqual({ ok: true, value: { exit: 126, output: '' } })
    expect((await askHumanVerbs({ host: null }).run({ verb: 'dotfiles-sync' })).ok).toBe(false)
    const broken = askHumanVerbs({ host: 'h', run: () => Promise.reject(new Error('no ssh')) })
    expect((await broken.run({ verb: 'dotfiles-sync' })).ok).toBe(false)
  })
})
