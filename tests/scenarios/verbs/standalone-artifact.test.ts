import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startVerbsWorld, type VerbsWorld } from './support.ts'

/**
 * A Report no Issue owns (`artifact new`), linked to the Issues it concerns: filed, replayed, linked, revised, annotated,
 * answered and given a verdict with no Issue and no attempt, through the real CLI against the real server.
 */
let v: VerbsWorld
let report = ''

const artifactOf = (out: { json: Record<string, unknown> | null }) =>
  out.json?.artifact as {
    id: string
    issueId: string | null
    repo: string | null
    links: string[]
    retiredAt: string | null
    revisions: unknown[]
  }

beforeAll(async () => {
  v = await startVerbsWorld()
})

afterAll(async () => {
  await v.stop()
})

test('issue new answers id beside issue', async () => {
  const filed = await v.run(['issue', 'new', '--repo', 'example', '--title', 'A build', '--alone'])
  expect(filed.json).toMatchObject({ issue: 'issue_1', id: 'issue_1', filed: true })
})

test('artifact new stores a Report with no Issue under the project, and the same content again is the same Report', async () => {
  const args = [
    'artifact',
    'new',
    '--repo',
    'example',
    '--title',
    'The orb review',
    '--content',
    '<h1>Orb</h1><p>Do it.</p>',
    '--content-format',
    'html',
  ]
  const made = await v.run(args, 'agent')
  expect(made.code).toBe(0)
  expect(made.json).toMatchObject({ result: 'applied', verdict: null, issue: null })
  const artifact = artifactOf(made)
  expect(artifact.issueId).toBeNull()
  expect(artifact.repo).toMatch(/example$/)
  expect(artifact.links).toEqual([])
  report = artifact.id

  const again = await v.run(args, 'agent')
  expect(again.json).toMatchObject({ result: 'replayed' })
  expect(artifactOf(again).id).toBe(report)
  const [count] = await v.w.world.db.sql`SELECT count(*)::int AS n FROM factory.artifacts WHERE issue_id IS NULL`
  expect(count).toMatchObject({ n: 1 })
})

test('a repo outside the roots, a Spec, a missing title and an unknown Issue are refused and store nothing', async () => {
  const outside = await v.run(['artifact', 'new', '--repo', '/etc', '--title', 't', '--content', 'x'])
  expect(outside.error?.code).toBe('repo_outside_roots')
  const spec = await v.run(['artifact', 'new', '--repo', 'example', '--kind', 'spec', '--title', 't', '--content', 'x'])
  expect(spec.code).not.toBe(0)
  const untitled = await v.run(['artifact', 'new', '--repo', 'example', '--content', 'x'])
  expect(untitled.error?.code).toBe('missing_field')
  const unknown = await v.run([
    'artifact',
    'new',
    '--repo',
    'example',
    '--title',
    'u',
    '--content',
    'x',
    '--issue',
    '99',
  ])
  expect(unknown.code).not.toBe(0)
  const [count] = await v.w.world.db.sql`SELECT count(*)::int AS n FROM factory.artifacts`
  expect(count).toMatchObject({ n: 1 })
})

test('artifact link adds an Issue; the artifact lists under it, and the Issue page shows it as linked', async () => {
  const linked = await v.run(['artifact', 'link', report, '--issue', '1'], 'agent')
  expect(linked.code).toBe(0)
  expect(linked.json).toMatchObject({ result: 'applied' })
  expect(artifactOf(linked).links).toEqual(['issue_1'])
  const again = await v.run(['artifact', 'link', report, '--issue', 'issue_1'], 'agent')
  expect(again.json).toMatchObject({ result: 'replayed' })

  const listed = await v.run(['artifact', 'list', '--issue', '1'])
  const listedIds = ((listed.json?.artifacts ?? []) as { id: string }[]).map((a) => a.id)
  expect(listedIds).toEqual([report])

  const missing = await v.run(['artifact', 'link', report, '--issue', '99'], 'agent')
  expect(missing.code).not.toBe(0)

  const shown = await v.run(['issue', 'show', 'issue_1'])
  expect(shown.json?.artifacts).toMatchObject([{ id: report, kind: 'report', linked: true }])
})

test('revise, annotate, reply and verdict need no Issue and no attempt', async () => {
  const revised = await v.run(['artifact', 'revise', report, '--content', '<h1>Orb</h1><p>Do it better.</p>'], 'agent')
  expect(revised.code).toBe(0)
  expect(artifactOf(revised).revisions).toHaveLength(2)

  const annotated = await v.run(['artifact', 'annotate', report, '--quote', 'Do it better.', '--comment', 'which way?'])
  expect(annotated.code).toBe(0)
  const [row] = await v.w.world.db.sql`SELECT id FROM factory.annotations WHERE artifact_id = ${report}`
  const replied = await v.run(
    ['artifact', 'annotation-reply', report, String(row?.id), '--disposition', 'applied', '--note', 'done'],
    'agent',
  )
  expect(replied.code).toBe(0)

  const verdict = await v.run(['artifact', 'verdict', report, '--verdict', 'looks_good'])
  expect(verdict.code).toBe(0)
  expect(verdict.json).toMatchObject({ issue: null })
})

test('the list says whether the owning Issue is closed and what its repo is; a standalone Report has neither', async () => {
  const listed = ((await v.run(['artifact', 'list'])).json?.artifacts ?? []) as {
    id: string
    issueId: string | null
    issueClosed: boolean | null
    issueRepo: string | null
  }[]
  const standalone = listed.find((a) => a.id === report)
  expect(standalone).toMatchObject({ issueClosed: null, issueRepo: null })
  const owned = listed.find((a) => a.issueId !== null)
  if (owned) expect(owned).toMatchObject({ issueClosed: expect.any(Boolean), issueRepo: expect.any(String) })
})

test('retire hides a Report from the list, its address still works, restore brings it back', async () => {
  const retired = await v.run(['artifact', 'retire', report], 'agent')
  expect(retired.code).toBe(0)
  expect(retired.json).toMatchObject({ result: 'applied' })
  expect(artifactOf(retired).retiredAt).not.toBeNull()
  const again = await v.run(['artifact', 'retire', report], 'agent')
  expect(again.json).toMatchObject({ result: 'replayed' })

  const idsOf = (out: { json: Record<string, unknown> | null }) =>
    ((out.json?.artifacts ?? []) as { id: string }[]).map((a) => a.id)
  expect(idsOf(await v.run(['artifact', 'list']))).toEqual([])
  expect(idsOf(await v.run(['artifact', 'list', '--issue', '1']))).toEqual([])
  expect(idsOf(await v.run(['artifact', 'list', '--retired', 'true']))).toEqual([report])
  const shown = await v.run(['artifact', 'show', report])
  expect(shown.code).toBe(0)

  const restored = await v.run(['artifact', 'restore', report], 'agent')
  expect(restored.json).toMatchObject({ result: 'applied' })
  expect(artifactOf(restored).retiredAt).toBeNull()
  expect(idsOf(await v.run(['artifact', 'list']))).toEqual([report])
  expect((await v.run(['artifact', 'restore', report], 'agent')).json).toMatchObject({ result: 'replayed' })
})

test('only a Report can be retired, and an unknown artifact is refused', async () => {
  expect((await v.run(['artifact', 'retire', 'artifact_999'], 'agent')).code).not.toBe(0)
  const [spec] = await v.w.world.db.sql`SELECT id FROM factory.artifacts WHERE kind <> 'report' LIMIT 1`
  if (spec) expect((await v.run(['artifact', 'retire', String(spec.id)], 'agent')).code).not.toBe(0)
})
