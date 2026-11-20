import { expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'bun:test'
import { agwPort, isUnavailable } from '../../src/adapters/agw/port.ts'
import { key } from '../../src/kernel/keys.ts'
import { WORKFLOWS, type WorkflowName } from '../../src/kernel/workflows.ts'
import { readFile } from 'node:fs/promises'

/** The five fail-closed workflows: an answer that says it is unavailable is a failed call; a real answer passes through. */
const fixture = JSON.parse(
  await readFile(
    join(import.meta.dir, '..', '..', '..', '..', 'packages', 'contract', 'fixtures', 'loops.json'),
    'utf8',
  ),
)
const answers: Partial<Record<WorkflowName, { reason: string }>> = {
  judge: fixture.judge.output,
  steward: fixture.steward.output,
  settle: fixture.triage.settleOutput,
  amend: fixture.triage.amendOutput,
  queue: fixture.queue.output,
  hygiene: fixture.hygiene.output,
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-agw-unavailable-')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** A stand-in `agw` that prints a finished run with this output. */
async function binAnswering(name: string, output: unknown): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\ncat >/dev/null; echo '${JSON.stringify({ runId: 'r', status: 'done', output })}'\n`)
  await chmod(path, 0o755)
  return path
}

test('the reasons the five workflows give when their model failed are unavailable; a judgment is not', () => {
  for (const reason of [
    'judge unavailable: model_error',
    'triage unavailable: timeout',
    'steward unavailable: error',
    'queue unavailable: invalid_output',
    'hygiene unavailable: a link leaves the checkout',
  ])
    expect(isUnavailable({ reason })).toBe(true)
  for (const reason of [
    'the service is unavailable to the public, so the Issue waits',
    'nothing scripted',
    'a judge unavailable later in the day is not this',
    '',
  ])
    expect(isUnavailable({ reason })).toBe(false)
})

test('the table marks the Judge, steward, settle, queue and hygiene as failing on an unavailable answer', () => {
  const failing = (Object.keys(WORKFLOWS) as WorkflowName[]).filter((name) => WORKFLOWS[name].failsWhenUnavailable)
  expect(failing).toEqual(['judge', 'steward', 'settle', 'queue', 'hygiene'])
})

test('an unavailable answer is a failed call (gone) for each of them, carrying the reason; amend takes it as an answer', async () => {
  for (const name of ['judge', 'steward', 'settle', 'queue', 'hygiene', 'amend'] as const) {
    const reason = `${name === 'judge' ? 'judge' : name === 'settle' || name === 'amend' ? 'triage' : name} unavailable: timeout`
    const bin = await binAnswering(name, { ...answers[name], reason })
    const result = await agwPort({ bin }).run(name, {} as never, key('test', name))
    if (name === 'amend') {
      expect(result).toMatchObject({ ok: true, value: { reason } })
      continue
    }
    expect(result).toMatchObject({ ok: false, error: { kind: 'gone' } })
    if (!result.ok) expect(result.error.detail).toContain(reason)
  }
})

test('an answer with a reason of its own passes through as it is', async () => {
  const bin = await binAnswering('real', { ...answers.queue, reason: 'the same files' })
  expect(await agwPort({ bin }).run('queue', {} as never, key('test', 'real'))).toMatchObject({
    ok: true,
    value: { reason: 'the same files' },
  })
})
