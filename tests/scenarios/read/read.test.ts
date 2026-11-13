import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ChangeList, ErrorBody, ReadIssueCards, ReadIssueDetail, ReadOverview } from '@software-factory/contract'
import { bearer, type ServerProcess, startWorld, type World } from '../harness.ts'
import { type Estate, makeEstate, startIntakeServer, until } from '../intake/support.ts'
import { patient } from '../patience.ts'

/**
 * The read API and the change stream against the real server process: an Issue filed through `POST /signals` shows on the
 * cards and the overview, and the SSE stream delivers its changes, resumes from a cursor with nothing lost and nothing
 * doubled, and is shut to a write by the read token.
 */
let world: World
let estate: Estate
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'argo' }])
  server = await startIntakeServer(world, estate, { FACTORY_STREAM_POLL_MS: '50' })
})

afterAll(async () => {
  await server.stop()
  await estate.stop()
  await world.stop()
})

const get = (path: string, caller: 'owner' | 'read' = 'owner', headers: Record<string, string> = {}) =>
  fetch(`${server.url}${path}`, { headers: { ...bearer(caller), ...headers } })

const file = async (title: string, caller: 'owner' | 'read' = 'owner') =>
  fetch(`${server.url}/signals`, {
    method: 'POST',
    headers: { ...bearer(caller), 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'owner:hermes', repo: 'argo', title }),
  })

interface Frame {
  id: string | null
  event: string | null
  data: string
}

/** The frames of an open stream, read as they arrive. */
function frames(response: Response) {
  if (!response.body) throw new Error('the stream has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const seen: Frame[] = []
  return {
    seen,
    /** reads until a frame satisfies `done` (the frames before it are in `seen`) */
    async until(done: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
      const deadline = Date.now() + patient(timeoutMs)
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (block.startsWith(':')) continue
          const frame: Frame = { id: null, event: null, data: '' }
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4)
            if (line.startsWith('event: ')) frame.event = line.slice(7)
            if (line.startsWith('data: ')) frame.data += line.slice(6)
          }
          seen.push(frame)
          if (done(frame)) return frame
          continue
        }
        if (Date.now() > deadline) throw new Error(`timed out; frames so far: ${JSON.stringify(seen)}`)
        const next = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)])
        if (next === null) continue
        if (next.done) throw new Error('the stream ended')
        buffer += decoder.decode(next.value, { stream: true })
      }
    },
    close: () => reader.cancel(),
  }
}

test('an Issue filed through the real route shows on the cards, the detail and the overview', async () => {
  const response = await file('The login page crashes on submit')
  expect(response.status).toBe(200)
  const ack = (await response.json()) as { issue: string }
  const number = Number(ack.issue.slice('issue_'.length))

  const list = ReadIssueCards.parse(await (await get('/v1/issues')).json())
  const card = list.issues.find((c) => c.ref === ack.issue)
  // the world has no project.yaml for the repo, so it is a work repo to the read token (the rule fails closed); the owner still reads it
  expect(card).toMatchObject({ id: number, title: 'The login page crashes on submit', repo: 'argo', visible: true })
  expect(card?.state).toMatch(/^(settling|queued|working)$/)

  const byRef = ReadIssueDetail.parse(await (await get(`/v1/issues/${ack.issue}`)).json())
  const byNumber = ReadIssueDetail.parse(await (await get(`/v1/issues/${number}`)).json())
  expect(byNumber.ref).toBe(byRef.ref)
  expect(byRef.timeline[0]).toMatchObject({ kind: 'filed' })

  const overview = ReadOverview.parse(await (await get('/v1/overview')).json())
  expect(overview.version).toBe('v1')
  expect(overview.uptime).toBeNull()
  expect(overview.issues.map((c) => c.ref)).toContain(ack.issue)
}, 30_000)

test('the stream resumes from a cursor with nothing lost and nothing doubled', async () => {
  // hello: the cursor "now"; then file work and follow it
  const first = frames(await get('/v1/stream'))
  const hello = await first.until((frame) => frame.event === 'hello')
  const start = hello.id
  expect(start).toMatch(/^\d+\.\d+$/)
  expect(JSON.parse(hello.data)).toEqual({ version: 'v1', cursor: start })

  expect((await file('Disk usage on the build host keeps growing')).status).toBe(200)
  const firstIssue = await first.until((frame) => frame.event === 'issue')
  expect(JSON.parse(firstIssue.data)).toMatchObject({
    kind: 'issue',
    subject: 'filed',
    ref: expect.stringMatching(/^issue_\d+$/),
  })
  await first.close()
  const lastSeen = first.seen.at(-1)?.id
  expect(lastSeen).toBeTruthy()

  // more work while no client is connected, then resume with Last-Event-ID
  expect((await file('The nightly backup job fails on Sundays')).status).toBe(200)
  await until('three Issues', async () => {
    const list = ReadIssueCards.parse(await (await get('/v1/issues')).json())
    return list.issues.length >= 3
  })
  const all = ChangeList.parse(await (await get(`/v1/changes?since=${start}&limit=500`)).json())
  const lastCursor = all.cursor
  expect(all.changes.length).toBeGreaterThan(3)

  const second = frames(await get('/v1/stream', 'owner', { 'last-event-id': lastSeen ?? '' }))
  await second.until((frame) => frame.id === lastCursor)
  await second.close()

  const ids = [
    ...first.seen.filter((frame) => frame.event !== 'hello').map((frame) => frame.id),
    ...second.seen.filter((frame) => frame.event !== 'hello').map((frame) => frame.id),
  ]
  expect(ids).toEqual(all.changes.map((change) => change.cursor))
  expect(new Set(ids).size).toBe(ids.length)
  expect(second.seen[0]).toMatchObject({ event: 'hello', id: lastSeen })
}, 60_000)

test('the issue filter keeps one Issue and a bad or future cursor is 410', async () => {
  const all = ChangeList.parse(await (await get('/v1/changes?since=0.0&limit=500')).json())
  const issue = all.changes.find((change) => change.issue !== null)?.issue ?? 0
  const only = ChangeList.parse(await (await get(`/v1/changes?since=0.0&issue=${issue}`)).json())
  expect(only.changes.length).toBeGreaterThan(0)
  expect(only.changes.every((change) => change.issue === issue)).toBe(true)

  for (const path of ['/v1/stream?since=garbage', '/v1/changes?since=garbage', '/v1/stream?since=1.99999999']) {
    const response = await get(path)
    expect(response.status).toBe(410)
    expect(ErrorBody.parse(await response.json()).code).toBe('cursor_gone')
  }
})

test('the read token reads /v1 and the stream, and a write is 403', async () => {
  expect((await get('/v1/issues', 'read')).status).toBe(200)
  expect((await get('/v1/overview', 'read')).status).toBe(200)
  const stream = await get('/v1/stream', 'read')
  expect(stream.status).toBe(200)
  await stream.body?.cancel()
  const write = await file('anything', 'read')
  expect(write.status).toBe(403)
  expect(ErrorBody.parse(await write.json()).code).toBe('forbidden')
  expect((await fetch(`${server.url}/v1/issues`)).status).toBe(401)
})
