import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { checkPath, shellCheckRunner } from '../../src/adapters/shell/check-runner.ts'
import { exitedNote } from '../../src/kernel/run.ts'
import { checkVerdict } from '../../src/domains/checkpoints/request.ts'

/** The real shell: what a check's exit and output come to. Short commands only. */
const runner = shellCheckRunner(undefined, 5_000)
const verdictOf = async (command: string) => checkVerdict(await runner.run(command))

test('exit 0 is needed, exit 1 not needed, with stderr folded into the output', async () => {
  expect(await runner.run('true')).toMatchObject({ exit: 0, timedOut: false })
  expect(await verdictOf('true')).toBe('needed')
  const failed = await runner.run('echo out; echo err >&2; exit 1')
  expect(failed.exit).toBe(1)
  expect(failed.output).toContain('out')
  expect(failed.output).toContain('err')
  expect(checkVerdict(failed)).toBe('not_needed')
})

test('a trailing comment does not break the check, and one that does not parse never closes a request', async () => {
  expect(await verdictOf('test -d /tmp # the directory exists')).toBe('needed')
  expect(await verdictOf('if then fi (')).toBe('unrunnable')
})

test('a missing command is a broken check, and a timeout says nothing about the need', async () => {
  expect(await verdictOf('a-command-that-does-not-exist-967')).toBe('broken')
  const slow = shellCheckRunner(undefined, 300)
  expect(checkVerdict(await slow.run('sleep 5'))).toBe('unrunnable')
})

test('a huge output keeps both its ends, and what is quoted of it is its first and last lines', async () => {
  const run = await runner.run('head -c 200000 /dev/zero | tr "\\0" "a"; exit 1')
  expect(run.output.length).toBeLessThanOrEqual(65_536 + 8)
  expect(exitedNote(run.exit, run.output).length).toBeLessThan(9000)
  const lines = await runner.run('seq 1 100; exit 1')
  const quoted = exitedNote(lines.exit, lines.output)
  expect(quoted).toStartWith('its check exited 1:\n1\n2\n')
  expect(quoted).toContain('… 60 lines left out …')
  expect(quoted).toEndWith('\n99\n100')
})

const hasSysctl = existsSync('/usr/sbin/sysctl') || existsSync('/sbin/sysctl')

test.skipIf(!hasSysctl)(
  'a check finds sysctl although the process PATH has no sbin directory (the bug as filed)',
  async () => {
    const before = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    try {
      const run = await shellCheckRunner(undefined, 5_000).run('command -v sysctl')
      expect(run.output).toMatch(/\/sysctl$/)
      expect(checkVerdict(run)).toBe('needed')
    } finally {
      process.env.PATH = before
    }
  },
)

test('a not-found line in the output of a check that exited 0 or 1 is a broken check, never "still needed"', () => {
  // `[ "$(sysctl -n kern.maxvnodes)" != 526336 ]` with no sysctl on the PATH: an empty string, exit 0
  expect(checkVerdict({ exit: 0, timedOut: false, output: 'sh: sysctl: command not found' })).toBe('broken')
  expect(checkVerdict({ exit: 1, timedOut: false, output: 'sh: 1: sysctl: not found' })).toBe('broken')
  expect(checkVerdict({ exit: 0, timedOut: false, output: 'all accessories respond' })).toBe('needed')
  expect(checkPath('/usr/bin:/bin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  expect(checkPath('/usr/bin:/usr/sbin')).toBe('/usr/bin:/usr/sbin:/sbin')
})
