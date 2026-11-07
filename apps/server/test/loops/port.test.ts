import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { agwPort } from '../../src/adapters/agw/port.ts'
import { key } from '../../src/kernel/keys.ts'

/** The agw port against a shell script standing in for the `agw` CLI: exit codes, the pending loop, the hang guard. */
let dir: string
beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-agw-port-')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const Output = z.object({ answer: z.string() })
const call = { workflow: 'factory-ask', input: { question: 'q' }, key: key('test', 'one'), output: Output }

async function agw(name: string, script: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
  return path
}

const envelope = (output: unknown, status = 'done') =>
  JSON.stringify({ runId: 'run-1', workflowId: 'factory-ask', status, output })

test('a finished run: the envelope’s output, checked against the schema, with the key and the input as sent', async () => {
  const seen = join(dir, 'seen')
  const bin = await agw(
    'done',
    `echo "$@" > ${seen}; echo "purpose=$AGW_PURPOSE" >> ${seen}; cat >> ${seen}; echo '${envelope({ answer: 'yes' })}'`,
  )
  const result = await agwPort({ bin }).run(call)
  expect(result).toEqual({ ok: true, value: { answer: 'yes' } })
  const sent = await readFile(seen, 'utf8')
  expect(sent).toContain('factory-ask --format json --idempotency-key test:one')
  expect(sent).toContain('{"question":"q"}')
  // agw refuses a purpose outside 1-64 of [A-Za-z0-9_.-] with a 400: found by the first live call
  expect(sent).toMatch(/purpose=[A-Za-z0-9_.-]{1,64}\n/)
})

test('exit 10 is pending: the run id in the envelope is waited for with `agw run wait` until it ends', async () => {
  const counter = join(dir, 'waits')
  await writeFile(counter, '')
  const bin = await agw(
    'pending',
    `if [ "$1" = run ]; then echo "$3" >> ${counter}; if [ "$(wc -l < ${counter})" -lt 3 ]; then echo '{"runId":"run-9","status":"running"}'; exit 10; fi; echo '${envelope({ answer: 'late' })}'; exit 0; fi
echo '{"runId":"run-9","status":"running"}'; echo 'kind: pending' >&2; exit 10`,
  )
  expect(await agwPort({ bin }).run(call)).toEqual({ ok: true, value: { answer: 'late' } })
  expect((await readFile(counter, 'utf8')).trim().split('\n')).toEqual(['run-9', 'run-9', 'run-9'])
})

test('the run id is read from the hint when stdout has no envelope', async () => {
  const bin = await agw(
    'hint',
    `if [ "$1" = run ]; then echo '${envelope({ answer: 'ok' })}'; exit 0; fi; echo 'hint: "agw run wait run-7"' >&2; exit 10`,
  )
  expect(await agwPort({ bin }).run(call)).toEqual({ ok: true, value: { answer: 'ok' } })
})

test('a pending run that names no run is unreadable, not a loop', async () => {
  const bin = await agw('nameless', 'exit 10')
  expect(await agwPort({ bin }).run(call)).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
})

test('a run that never ends is killed at the hang guard and is a timeout', async () => {
  const bin = await agw('hang', 'sleep 30')
  const started = Date.now()
  const result = await agwPort({ bin, hangGuardMs: 300 }).run(call)
  expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } })
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('the hang guard covers the whole call, the waits of a pending run included', async () => {
  const bin = await agw(
    'slow-pending',
    `if [ "$1" = run ]; then sleep 0.2; echo '{"runId":"r"}'; exit 10; fi; echo '{"runId":"r"}'; exit 10`,
  )
  const result = await agwPort({ bin, hangGuardMs: 700 }).run(call)
  expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } })
})

test('a failed exit is gone, with what agw said; a failed or cancelled run is gone too', async () => {
  const failed = await agw('exit7', 'echo "network down" >&2; exit 7')
  expect(await agwPort({ bin: failed }).run(call)).toMatchObject({
    ok: false,
    error: { kind: 'gone', detail: expect.stringContaining('exited 7: network down') },
  })
  const cancelled = await agw('cancelled', `echo '${envelope(null, 'cancelled')}'`)
  expect(await agwPort({ bin: cancelled }).run(call)).toMatchObject({ ok: false, error: { kind: 'gone' } })
  expect(await agwPort({ bin: join(dir, 'not-there') }).run(call)).toMatchObject({ ok: false, error: { kind: 'gone' } })
})

test('stdout that is not a run envelope, or an output the schema refuses, is unreadable', async () => {
  const garbage = await agw('garbage', 'echo "not json"')
  expect(await agwPort({ bin: garbage }).run(call)).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
  const bare = await agw('bare', `echo '{"answer":"no envelope"}'`)
  expect(await agwPort({ bin: bare }).run(call)).toMatchObject({ ok: false, error: { kind: 'gone' } })
  const wrong = await agw('wrong', `echo '${envelope({ nope: 1 })}'`)
  expect(await agwPort({ bin: wrong }).run(call)).toMatchObject({
    ok: false,
    error: { kind: 'unreadable', detail: expect.stringContaining('answer') },
  })
})
