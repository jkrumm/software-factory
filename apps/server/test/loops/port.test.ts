import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agwPort } from '../../src/adapters/agw/port.ts'
import { key } from '../../src/kernel/keys.ts'

/** The agw port against a shell script standing in for the `agw` CLI: exit codes, the pending loop, the hang guard. */
let dir: string
beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-agw-port-')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** The Judge's answer is the shape the fake agw prints; `said` is one whose `answer` tells the runs apart. */
const said = (answer: string) => ({ verdict: 'answer' as const, answer, reason: 'because', source: 'a test' })
const request = { question: 'q' } as never
const callKey = key('test', 'one')
const run = (options: Parameters<typeof agwPort>[0]) => agwPort(options).run('judge', request, callKey)

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
    `echo "$@" > ${seen}; echo "purpose=$AGW_PURPOSE" >> ${seen}; cat >> ${seen}; echo '${envelope(said('yes'))}'`,
  )
  const result = await run({ bin })
  expect(result).toEqual({ ok: true, value: said('yes') })
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
    `if [ "$1" = run ]; then echo "$3" >> ${counter}; if [ "$(wc -l < ${counter})" -lt 3 ]; then echo '{"runId":"run-9","status":"running"}'; exit 10; fi; echo '${envelope(said('late'))}'; exit 0; fi
echo '{"runId":"run-9","status":"running"}'; echo 'kind: pending' >&2; exit 10`,
  )
  expect(await run({ bin })).toEqual({ ok: true, value: said('late') })
  expect((await readFile(counter, 'utf8')).trim().split('\n')).toEqual(['run-9', 'run-9', 'run-9'])
})

test('the run id is read from the hint when stdout has no envelope', async () => {
  const bin = await agw(
    'hint',
    `if [ "$1" = run ]; then echo '${envelope(said('ok'))}'; exit 0; fi; echo 'hint: "agw run wait run-7"' >&2; exit 10`,
  )
  expect(await run({ bin })).toEqual({ ok: true, value: said('ok') })
})

test('a pending run that names no run is unreadable, not a loop', async () => {
  const bin = await agw('nameless', 'exit 10')
  expect(await run({ bin })).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
})

test('a silent process is ended by the idle watchdog and is a timeout', async () => {
  const bin = await agw('hang', 'sleep 30')
  const started = Date.now()
  const result = await run({ bin, idleMs: 300 })
  expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } })
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a process that keeps printing runs past the idle time and is not killed', async () => {
  const bin = await agw(
    'chatty',
    `i=0; while [ $i -lt 15 ]; do echo "step $i" >&2; sleep 0.1; i=$((i+1)); done; echo '${envelope(said('slow'))}'`,
  )
  const started = Date.now()
  expect(await run({ bin, idleMs: 400 })).toEqual({ ok: true, value: said('slow') })
  expect(Date.now() - started).toBeGreaterThan(1_200)
})

test('a pending run that keeps answering is waited for past the idle time: there is no wall-clock ceiling', async () => {
  const counter = join(dir, 'slow-waits')
  await writeFile(counter, '')
  const bin = await agw(
    'slow-pending',
    `if [ "$1" = run ]; then sleep 0.2; echo x >> ${counter}; if [ "$(wc -l < ${counter})" -lt 6 ]; then echo '{"runId":"r"}'; exit 10; fi; echo '${envelope(said('late'))}'; exit 0; fi; echo '{"runId":"r"}'; exit 10`,
  )
  const started = Date.now()
  expect(await run({ bin, idleMs: 700 })).toEqual({ ok: true, value: said('late') })
  expect(Date.now() - started).toBeGreaterThan(1_000)
})

test('a wait that goes silent after the run began pending is ended by the watchdog', async () => {
  const bin = await agw('wedged-wait', `if [ "$1" = run ]; then sleep 30; fi; echo '{"runId":"r"}'; exit 10`)
  expect(await run({ bin, idleMs: 300 })).toMatchObject({ ok: false, error: { kind: 'timeout' } })
})

test('a failed exit is gone, with what agw said; a failed or cancelled run is gone too', async () => {
  const failed = await agw('exit7', 'echo "network down" >&2; exit 7')
  expect(await run({ bin: failed })).toMatchObject({
    ok: false,
    error: { kind: 'gone', detail: expect.stringContaining('exited 7: network down') },
  })
  const cancelled = await agw('cancelled', `echo '${envelope(null, 'cancelled')}'`)
  expect(await run({ bin: cancelled })).toMatchObject({ ok: false, error: { kind: 'gone' } })
  expect(await run({ bin: join(dir, 'not-there') })).toMatchObject({ ok: false, error: { kind: 'gone' } })
})

test('stdout that is not a run envelope, or an output the schema refuses, is unreadable', async () => {
  const garbage = await agw('garbage', 'echo "not json"')
  expect(await run({ bin: garbage })).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
  const bare = await agw('bare', `echo '{"answer":"no envelope"}'`)
  expect(await run({ bin: bare })).toMatchObject({ ok: false, error: { kind: 'gone' } })
  const wrong = await agw('wrong', `echo '${envelope({ nope: 1 })}'`)
  expect(await run({ bin: wrong })).toMatchObject({
    ok: false,
    error: { kind: 'unreadable', detail: expect.stringContaining('verdict') },
  })
})
