import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startVerbsWorld, type VerbsWorld } from './support.ts'

/**
 * A collection of artifacts (`artifact collection-*`): made with its lead page, edited, pinned and unpinned, with an
 * artifact in at most one, through the real CLI against the real server.
 */
let v: VerbsWorld
const reports: string[] = []

interface Collection {
  id: string
  title: string
  repo: string
  lead: string | null
  pinnedAt: string | null
  members: string[]
  memberCount: number
  lastChange: string | null
  openComments: number
}
const collectionOf = (out: { json: Record<string, unknown> | null }) => out.json?.collection as Collection

beforeAll(async () => {
  v = await startVerbsWorld()
  for (const title of ['Overview', 'Part one', 'Part two']) {
    const made = await v.run(
      ['artifact', 'new', '--repo', 'example', '--title', title, '--content', `# ${title}`],
      'agent',
    )
    expect(made.code).toBe(0)
    reports.push(((made.json ?? {}).artifact as { id: string }).id)
  }
})

afterAll(async () => {
  await v.stop()
})

test('collection-new takes its lead page and members, and the same key again files nothing', async () => {
  const [overview, one] = reports as [string, string, string]
  const args = [
    'artifact',
    'collection-new',
    '--title',
    'Orb rewrite',
    '--lead',
    overview,
    '--add',
    one,
    '--key',
    'orb',
  ]
  const made = await v.run(args, 'agent')
  expect(made.code).toBe(0)
  expect(made.json).toMatchObject({ result: 'applied' })
  const collection = collectionOf(made)
  expect(collection).toMatchObject({
    title: 'Orb rewrite',
    lead: overview,
    pinnedAt: null,
    memberCount: 2,
    openComments: 0,
  })
  expect(collection.repo).toMatch(/example$/)
  expect(collection.members).toEqual([overview, one])
  expect(collection.lastChange).not.toBeNull()

  const again = await v.run(args, 'agent')
  expect(again.json).toMatchObject({ result: 'replayed' })
  expect(collectionOf(again).id).toBe(collection.id)

  const shown = await v.run(['artifact', 'show', one])
  expect(((shown.json ?? {}).artifact as { collectionId: string }).collectionId).toBe(collection.id)
})

test('an artifact belongs to at most one collection, and a missing title or an unknown artifact is refused', async () => {
  const [overview, , two] = reports as [string, string, string]
  const taken = await v.run(
    ['artifact', 'collection-new', '--title', 'Other', '--add', overview, '--key', 'other'],
    'agent',
  )
  expect(taken.error?.code).toBe('refused')
  const untitled = await v.run(['artifact', 'collection-new', '--add', two], 'agent')
  expect(untitled.error?.code).toBe('missing_field')
  const unknown = await v.run(
    ['artifact', 'collection-new', '--title', 'X', '--add', 'artifact_999', '--key', 'x'],
    'agent',
  )
  expect(unknown.error?.code).toBe('not_found')
  const [count] = await v.w.world.db.sql`SELECT count(*)::int AS n FROM factory.artifact_collections`
  expect(count).toMatchObject({ n: 1 })
})

test('edit retitles, takes artifacts in and out, and a call that changes nothing is a replay', async () => {
  const [overview, one, two] = reports as [string, string, string]
  const [row] = await v.w.world.db.sql`SELECT id FROM factory.artifact_collections LIMIT 1`
  const id = String(row?.id)
  const edited = await v.run(
    ['artifact', 'collection-edit', id, '--title', 'Orb rewrite, V2', '--add', two, '--remove', one],
    'agent',
  )
  expect(edited.json).toMatchObject({ result: 'applied' })
  expect(collectionOf(edited)).toMatchObject({ title: 'Orb rewrite, V2', members: [overview, two] })
  const same = await v.run(['artifact', 'collection-edit', id, '--title', 'Orb rewrite, V2', '--add', two], 'agent')
  expect(same.json).toMatchObject({ result: 'replayed' })

  const dropped = await v.run(['artifact', 'collection-edit', id, '--remove', overview], 'agent')
  expect(collectionOf(dropped)).toMatchObject({ lead: null, members: [two] })
  const led = await v.run(['artifact', 'collection-edit', id, '--lead', overview], 'agent')
  expect(collectionOf(led)).toMatchObject({ lead: overview, members: [overview, two] })
  expect((await v.run(['artifact', 'collection-edit', id, '--title', ' '], 'agent')).error?.code).toBe(
    'invalid_request',
  )
})

test('pin and unpin are the owner and orchestrator, listed first, and doing either twice is a replay', async () => {
  const [row] = await v.w.world.db.sql`SELECT id FROM factory.artifact_collections LIMIT 1`
  const id = String(row?.id)
  const other = await v.run(
    ['artifact', 'collection-new', '--title', 'Newer', '--repo', 'example', '--key', 'newer'],
    'agent',
  )
  const newer = collectionOf(other).id

  expect((await v.run(['artifact', 'collection-pin', id], 'agent')).code).not.toBe(0)
  const pinned = await v.run(['artifact', 'collection-pin', id])
  expect(pinned.json).toMatchObject({ result: 'applied' })
  expect(collectionOf(pinned).pinnedAt).not.toBeNull()
  expect((await v.run(['artifact', 'collection-pin', id])).json).toMatchObject({ result: 'replayed' })

  const listed = await v.run(['artifact', 'collection-list'], 'agent')
  const ids = ((listed.json?.collections ?? []) as Collection[]).map((c) => c.id)
  expect(ids).toEqual([id, newer])

  const unpinned = await v.run(['artifact', 'collection-unpin', id])
  expect(unpinned.json).toMatchObject({ result: 'applied' })
  expect(collectionOf(unpinned).pinnedAt).toBeNull()
  expect((await v.run(['artifact', 'collection-unpin', id])).json).toMatchObject({ result: 'replayed' })
  expect((await v.run(['artifact', 'collection-show', 'collection_nope'])).code).not.toBe(0)
})

test("a collection counts the owner's comments the lead has not answered", async () => {
  const [, , two] = reports as [string, string, string]
  const [row] = await v.w.world.db.sql`SELECT id FROM factory.artifact_collections WHERE title = 'Orb rewrite, V2'`
  const annotate = await v.run(
    ['artifact', 'annotate', two, '--revision', '1', '--quote', 'Part two', '--comment', 'Why?'],
    'owner',
  )
  expect(annotate.code).toBe(0)
  const shown = await v.run(['artifact', 'collection-show', String(row?.id)])
  expect(collectionOf(shown).openComments).toBe(1)
})
