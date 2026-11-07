import { afterAll, beforeAll, expect, test } from 'bun:test'
import { call, fieldsOf, startClientsWorld, type VerbsWorld } from './support.ts'

/**
 * Group A, the lead's verbs: a fake lead is the CLI under the agent token with the environment of a started lead
 * (`FACTORY_SESSION=lead-<n>-<attempt>`). Every `factory ...` command the lead's brief names is run against the real server.
 */
let v: VerbsWorld
let issue = ''
let session = ''
let brief = ''
let lead: Record<string, string> = {}

beforeAll(async () => {
  v = await startClientsWorld()
  issue = await v.w.admitted('the checkout page hangs on submit')
  await v.w.tick()
  const terminal = v.w.terminals().at(-1)
  session = terminal?.labels['factory.key'] ?? ''
  brief = terminal?.argv.at(-1) ?? ''
  lead = { FACTORY_SESSION: session }
}, 60_000)

afterAll(async () => {
  await v.stop()
})

const asLead = (args: string[]) => call(v, args, 'agent', lead)

test('the session is the lead key and the brief lists the standing orders', () => {
  expect(session).toBe(`lead-${issue.slice('issue_'.length)}-1`)
  expect(brief).toContain('## ')
})

test('every verb the brief names is a command of the CLI', async () => {
  const pairs = new Set<string>()
  for (const match of brief.matchAll(/`factory ([a-z][a-z-]*) ([a-z][a-z-]*)/g)) pairs.add(`${match[1]} ${match[2]}`)
  const names = [...pairs]
  // the verbs the standing orders must teach
  for (const verb of [
    'issue show',
    'issue close',
    'issue defer',
    'issue block',
    'issue ship',
    'issue ask',
    'artifact submit',
    'artifact revise',
    'artifact show',
    'errand raise',
    'signal file',
  ]) {
    expect(names).toContain(verb)
  }
  for (const name of names) {
    const [group, verb] = name.split(' ') as [string, string]
    const help = await call(v, [group, verb, '--help'], 'none')
    expect({ name, code: help.code }).toEqual({ name, code: 0 })
  }
})

test('issue show reads the Issue by ref and by number; the fields a lead reads are there', async () => {
  const number = issue.slice('issue_'.length)
  for (const id of [issue, number]) {
    const shown = await asLead(['issue', 'show', id])
    expect(shown.code).toBe(0)
    expect(
      fieldsOf(shown.json, {
        id: 'number',
        ref: 'string',
        title: 'string',
        state: 'string',
        timeline: 'array',
        evidence: 'array',
        asks: 'array',
        sessions: 'array',
      }),
    ).toEqual([])
    expect(shown.json).toMatchObject({ ref: issue, state: 'working' })
  }
})

test('an owner verb with the agent token is 403 forbidden (exit 3)', async () => {
  for (const args of [
    ['issue', 'cancel', issue, '--reason', 'no'],
    ['issue', 'note', issue, 'hello'],
    ['issue', 'answer', issue, 'yes'],
    ['issue', 'prio', issue, '5'],
    ['queue', 'set', 'drain'],
    ['errand', 'list'],
  ]) {
    const refused = await asLead(args)
    expect({ args, code: refused.code, kind: refused.error?.code }).toEqual({ args, code: 3, kind: 'forbidden' })
  }
})

test('issue ask: a complete form is a Decision; an incomplete one prints missing_field with its fields', async () => {
  const refused = await asLead(['issue', 'ask', issue, '--attempt', '1', '--question', 'Which way?'])
  expect(refused.code).not.toBe(0)
  expect(refused.error?.code).toBe('missing_field')
  const fields = refused.error?.details.fields
  expect(Array.isArray(fields)).toBe(true)
  expect(JSON.stringify(fields)).toContain('recommendation')

  const options = JSON.stringify([
    { label: 'Ship the quick fix', reversible: true, cost: 'one hour' },
    { label: 'Redesign the form', reversible: false, cost: 'two days' },
  ])
  const noAnswer = JSON.stringify({
    consequence: 'the quick fix ships',
    default: 'Ship the quick fix',
    waitMinutes: 600,
  })
  const asked = await asLead([
    'issue',
    'ask',
    issue,
    '--attempt',
    '1',
    '--question',
    'Which way do we fix the checkout hang?',
    '--recommendation',
    'Ship the quick fix',
    '--checked',
    'the submit handler and its timeout',
    '--options',
    options,
    '--no-answer',
    noAnswer,
  ])
  expect(asked.error).toBeNull()
  expect(asked.code).toBe(0)
  expect(asked.json).toMatchObject({ result: 'applied' })
})

test('the owner answers the Decision and the answer reaches the lead as a note typed into its session', async () => {
  const before = v.w.terminals().at(-1)?.sent.length ?? 0
  const answered = await call(v, ['issue', 'answer', issue, 'Ship the quick fix'])
  expect(answered.code).toBe(0)
  await v.w.tick()
  const heard = (v.w.terminals().at(-1)?.sent ?? []).slice(before).join('\n')
  expect(heard).toContain('Ship the quick fix')
  // repeating the answer changes nothing and does not type it twice
  const again = await call(v, ['issue', 'answer', issue, 'Ship the quick fix'])
  expect(again.error?.code ?? 'ok').not.toBe('forbidden')
})

test('artifact submit, show and revise; errand raise; defer; signal file', async () => {
  const submitted = await asLead([
    'artifact',
    'submit',
    issue,
    '--attempt',
    '1',
    '--kind',
    'report',
    '--title',
    'What I found',
    '--content',
    '# Found\n\nThe timeout is 0.',
    '--content-format',
    'markdown',
  ])
  expect(submitted.code).toBe(0)
  const artifact = String((submitted.json as { artifact: { id: string } }).artifact.id)

  const shown = await asLead(['artifact', 'show', artifact])
  expect(shown.code).toBe(0)
  expect(fieldsOf(shown.json, { artifact: 'object', annotations: 'array' })).toEqual([])

  const revised = await asLead([
    'artifact',
    'revise',
    artifact,
    '--content',
    '# Found\n\nThe timeout is 0, fixed.',
    '--note',
    'clarified',
    '--attempt',
    '1',
  ])
  expect(revised.code).toBe(0)

  const errand = await asLead(['errand', 'raise', issue, '--attempt', '1', '--summary', 'plug it in', '--detail', 'x'])
  expect(errand.code).toBe(0)
  expect(fieldsOf((errand.json as { errand: unknown }).errand, { id: 'string' })).toEqual([])

  const filed = await asLead([
    'signal',
    'file',
    '--from',
    'agent:example',
    '--title',
    'Follow-up from the lead',
    '--repo',
    'example',
  ])
  expect(filed.code).toBe(0)
})

test('issue ship is reachable: the gate refuses in the fake repo with exit 5 and a coded stderr line', async () => {
  const ship = await asLead(['issue', 'ship', issue, '--attempt', '1', '--call', 's1', '--commit', 'aaaa111'])
  expect(ship.code).toBe(5)
  expect(ship.error?.kind).toBeTruthy()
  expect(ship.error?.message).toContain('aaaa111')
})

/** A fresh Issue with a started lead, and the lead's environment. */
async function started(title: string): Promise<{ issue: string; env: Record<string, string> }> {
  const id = await v.w.admitted(title)
  await v.w.tick()
  return { issue: id, env: { FACTORY_SESSION: `lead-${id.slice('issue_'.length)}-1` } }
}

test("issue defer, block and close end a lead's work", async () => {
  const waits = await started('a thing that waits for a date')
  const deferred = await call(
    v,
    ['issue', 'defer', waits.issue, '--attempt', '1', '--until', '2099-01-01T00:00:00Z'],
    'agent',
    waits.env,
  )
  expect(deferred.err).toBe('')
  expect(deferred.json).toMatchObject({ issue: { state: 'waiting' } })

  const stuck = await started('a thing that must block')
  const blocked = await call(
    v,
    ['issue', 'block', stuck.issue, '--attempt', '1', '--reason', 'the contract must change'],
    'agent',
    stuck.env,
  )
  expect(blocked.err).toBe('')

  const done = await started('a thing that needs no commit')
  const closed = await call(
    v,
    ['issue', 'close', done.issue, '--attempt', '1', '--outcome', 'dropped', '--reason', 'superseded'],
    'agent',
    done.env,
  )
  expect(closed.err).toBe('')
  expect(closed.json).toMatchObject({ issue: { state: 'closed' } })
})
