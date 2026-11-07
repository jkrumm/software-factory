import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Health } from '@software-factory/contract'
import { factory, type ServerProcess, startServer, startWorld, type World } from './harness.ts'

let world: World
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  server = await startServer(world)
})

afterAll(async () => {
  await server.stop()
  await world.stop()
})

const cli = (args: string[], as?: Parameters<typeof factory>[3]) =>
  factory(world, args, { FACTORY_URL: server.url }, as)

const errorLine = (text: string) => (JSON.parse(text) as { error: Record<string, unknown> }).error

test('health get needs no token: Health on stdout, nothing on stderr', async () => {
  const result = await cli(['health', 'get'], { as: 'none' })
  expect(result.code).toBe(0)
  expect(Health.parse(JSON.parse(result.out)).status).toBe('ok')
  expect(result.err).toBe('')
})

test('flags build the body: an unknown Issue is a 404 on stderr as one JSON line, exit 4, stdout empty', async () => {
  const result = await cli([
    'issue',
    'close',
    'issue_999',
    '--attempt',
    '1',
    '--outcome',
    'done',
    '--reason',
    'nothing to do',
  ])
  expect(result.code).toBe(4)
  expect(result.out).toBe('')
  expect(errorLine(result.err)).toMatchObject({
    kind: 'not_found',
    code: 'not_found',
    message: 'no Issue issue_999',
    details: { status: 404 },
  })
})

test('a form with missing fields is a 422 that names them in details.fields, exit 2', async () => {
  const result = await cli(['issue', 'close', 'issue_1', '--attempt', '1'])
  expect(result.code).toBe(2)
  expect(result.out).toBe('')
  expect(errorLine(result.err)).toMatchObject({
    kind: 'usage',
    code: 'invalid_request',
    details: { status: 422, fields: ['outcome', 'reason'] },
  })
})

test('a flag the CLI cannot read is exit 2 before any call', async () => {
  const result = await cli(['issue', 'close', 'issue_1', '--attempt', 'one'])
  expect(result.code).toBe(2)
  expect(errorLine(result.err).message).toContain('--attempt')
})

test('no token is a 401, exit 3', async () => {
  const result = await cli(['capacity', 'get'], { as: 'none' })
  expect(result.code).toBe(3)
  expect(result.out).toBe('')
  expect(errorLine(result.err)).toMatchObject({ kind: 'auth', code: 'unauthorized', details: { status: 401 } })
})

test('the read token reads /v1 and is refused everywhere else, exit 3', async () => {
  expect((await cli(['loop', 'list'], { as: 'read' })).code).toBe(0)
  const refused = await cli(['capacity', 'get'], { as: 'read' })
  expect(refused.code).toBe(3)
  expect(errorLine(refused.err)).toMatchObject({ code: 'forbidden', details: { status: 403 } })
  const write = await cli(['planning', 'prio', '--issue', 'issue_1', '--value', '1'], { as: 'read' })
  expect(write.code).toBe(3)
})

test("a lead's agent token may close its Issue but not use the owner's verbs", async () => {
  const lead = await cli(['issue', 'close', 'issue_999', '--attempt', '1', '--outcome', 'done', '--reason', 'x'], {
    as: 'agent',
  })
  expect(lead.code).toBe(4)
  const owner = await cli(['planning', 'prio', '--issue', 'issue_1', '--value', '1'], { as: 'agent' })
  expect(owner.code).toBe(3)
  expect(errorLine(owner.err).code).toBe('forbidden')
})

test("the door's token files nothing but alerts and reports", async () => {
  const refused = await cli(['loop', 'list'], { as: 'machine' })
  expect(refused.code).toBe(3)
  expect(errorLine(refused.err).code).toBe('forbidden')
})

test('the server refuses to start without FACTORY_TOKEN, naming it', async () => {
  const bare = await startServer(world, { env: { FACTORY_TOKEN: '' }, ready: false })
  expect(await bare.exited()).toBe(1)
  expect(bare.output()).toContain('FACTORY_TOKEN')
})
