import { expect, test } from 'bun:test'
import { shellCheckRunner } from '../../src/adapters/shell/check-runner.ts'
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

test('a missing command and a timeout say nothing about the need', async () => {
  expect(await verdictOf('a-command-that-does-not-exist-967')).toBe('unrunnable')
  const slow = shellCheckRunner(undefined, 300)
  expect(checkVerdict(await slow.run('sleep 5'))).toBe('unrunnable')
})

test('the output is cut', async () => {
  const run = await runner.run('head -c 20000 /dev/zero | tr "\\0" "a"; exit 1')
  expect(run.output.length).toBeLessThanOrEqual(2048)
})
