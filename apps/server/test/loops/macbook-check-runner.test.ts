import { expect, test } from 'bun:test'
import { macbookCheckRunner } from '../../src/adapters/shell/macbook-check-runner.ts'
import type { CheckRunner, MacbookVerbPort } from '../../src/domains/errands/ports.ts'
import { MACBOOK_REPORTS } from '../../src/domains/errands/need.ts'
import { checkVerdict } from '../../src/domains/errands/request.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const REPORT = MACBOOK_REPORTS['smb-mounts'] ?? ''

function setup(answer: Awaited<ReturnType<MacbookVerbPort['run']>>) {
  const asked: string[] = []
  const local: CheckRunner = {
    run: async (command) => {
      asked.push(`local: ${command}`)
      return { exit: 0, timedOut: false, output: 'local' }
    },
  }
  const macbook: MacbookVerbPort = {
    run: async (verb) => {
      asked.push(`macbook: ${JSON.stringify(verb)}`)
      return answer
    },
  }
  return { asked, runner: macbookCheckRunner({ local, macbook }) }
}

test('a check that is not a MacBook report runs where the factory does', async () => {
  const { asked, runner } = setup(ok({ exit: 0, output: '[exit 0]\n' }))
  expect(await runner.run('test -d /tmp')).toEqual({ exit: 0, timedOut: false, output: 'local' })
  expect(asked).toEqual(['local: test -d /tmp'])
})

test("a report's own exit is the check's exit, its output the check's output", async () => {
  const found = setup(ok({ exit: 0, output: '//host/share on /Volumes/share (smbfs)\n[exit 0]\n' }))
  const needed = await found.runner.run(REPORT)
  expect(needed).toEqual({ exit: 0, timedOut: false, output: '//host/share on /Volumes/share (smbfs)' })
  expect(found.asked).toEqual(['macbook: {"verb":"report","name":"smb-mounts"}'])
  const none = setup(ok({ exit: 0, output: '[exit 1]\n' }))
  expect(checkVerdict(await none.runner.run(REPORT))).toBe('not_needed')
})

test('an unreachable MacBook, a refused verb, a timeout or a missing exit line never closes an Errand', async () => {
  for (const answer of [
    err(portError('gone', 'ssh could not start')),
    ok({ exit: 255, output: 'ssh: connect to host timed out' }),
    ok({ exit: 126, output: '' }),
    ok({ exit: 0, output: 'half an answ' }),
    ok({ exit: 0, output: 'slow\n[exit 124]\n' }),
  ]) {
    const run = await setup(answer).runner.run(REPORT)
    expect(run.exit).toBeNull()
    expect(checkVerdict(run)).toBe('unrunnable')
  }
})
