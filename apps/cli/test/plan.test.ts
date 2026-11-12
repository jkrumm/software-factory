import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLAN_LIMITS } from '@software-factory/contract'
import { artifactListPlain, issueListPlain, projectShowPlain } from '../src/plain-forms.ts'
import { run } from '../src/run.ts'

const ROOT = join(import.meta.dir, '..', '..', '..')
let dir: string
let stdinText = ''

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-cli-plan-')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function cli(argv: string[]) {
  let out = ''
  let err = ''
  const code = await run(argv, {
    env: {},
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    stdin: () => Promise.resolve(stdinText),
    readFile: (path) => Bun.file(path).text(),
  })
  return { code, out, err }
}

const facts = ['    facts:', '      why: |-', '        because']
const row = (key: string, extra: string[] = []) => [`  - key: ${key}`, `    title: ${key}`, ...facts, ...extra]
const file = (...rows: string[][]) => ['version: 1', 'rows:', ...rows.flat(), ''].join('\n')

async function checkText(text: string, name = 'plan.yaml') {
  const path = join(dir, name)
  await writeFile(path, text)
  return { ...(await cli(['plan', 'check', path])), path }
}

/** the line numbers a plain run reports for a file */
const linesOf = (out: string, path: string) =>
  out
    .split('\n')
    .filter((l) => l.startsWith(`${path}:`))
    .map((l) => Number(l.slice(path.length + 1).split(':')[0]))

describe('factory plan check', () => {
  test('the example in docs/plan.md and the factory plan pass, exit 0 and nothing on stderr', async () => {
    const doc = await Bun.file(join(ROOT, 'docs', 'plan.md')).text()
    const example = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1] ?? ''
    const result = await checkText(example, 'example.yaml')
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    expect(result.out).toContain(`ok: ${result.path}, 4 rows`)
    const own = await cli(['plan', 'check', join(ROOT, 'docs', 'plan.yaml')])
    expect(own.code).toBe(0)
  })

  test('a one-line fact with a colon is a syntax error at its line, with the quoting hint', async () => {
    const text = [
      'version: 1',
      'rows:',
      '  - key: a',
      '    title: A',
      '    facts:',
      '      why: Fix the thing: now',
      '',
    ].join('\n')
    const result = await checkText(text)
    expect(result.code).toBe(2)
    expect(linesOf(result.out, result.path)).toContain(6)
    expect(result.out).toContain('block scalar')
    expect(JSON.parse(result.err).error.message).toBe(`${result.path}: 1 problem(s)`)
  })

  test('an unknown key on a row is named at its line', async () => {
    const text = file(row('a'), row('b', ['    bogus: 1']), row('c'))
    const result = await checkText(text)
    expect(result.code).toBe(2)
    const line = text.split('\n').indexOf('    bogus: 1') + 1
    expect(linesOf(result.out, result.path)).toEqual([line])
    expect(result.out).toContain('unknown key bogus')
  })

  test('an unknown after key is reported at the entry', async () => {
    const text = file(row('a'), row('b', ['    after:', '      - a', '      - ghost']))
    const result = await checkText(text)
    expect(result.code).toBe(2)
    expect(linesOf(result.out, result.path)).toEqual([text.split('\n').indexOf('      - ghost') + 1])
  })

  test('a cycle is reported at the after of its first row', async () => {
    const text = file(row('a', ['    after: [b]']), row('b', ['    after: [a]']))
    const result = await checkText(text)
    expect(result.code).toBe(2)
    expect(linesOf(result.out, result.path)).toEqual([text.split('\n').indexOf('    after: [b]') + 1])
    expect(result.out).toContain('after forms a cycle: a -> b -> a')
  })

  test('a missing title is reported at the row', async () => {
    const text = ['version: 1', 'rows:', '  - key: a', ...facts, ''].join('\n')
    const result = await checkText(text)
    expect(result.code).toBe(2)
    expect(linesOf(result.out, result.path)).toEqual([3])
  })

  test('a file over 64 KiB is an error and is not parsed', async () => {
    const result = await checkText(`# ${'x'.repeat(PLAN_LIMITS.maxBytes)}\n${file(row('a'))}`)
    expect(result.code).toBe(2)
    expect(result.out).toContain('larger than')
  })

  test('more than 20 after keys is an error at the row', async () => {
    const after = Array.from({ length: 21 }, (_, i) => `other:r${i}`).join(', ')
    const text = file(row('a'), row('b', [`    after: [${after}]`]))
    const result = await checkText(text)
    expect(result.code).toBe(2)
    expect(linesOf(result.out, result.path)).toEqual([text.split('\n').indexOf('  - key: b') + 1])
    expect(result.out).toContain('21 after keys')
  })

  test('--format json prints the verdict and the problems with line, column and path', async () => {
    const text = file(row('a', ['    after: [ghost]']))
    const path = join(dir, 'json.yaml')
    await writeFile(path, text)
    const result = await cli(['plan', 'check', path, '--format', 'json'])
    expect(result.code).toBe(2)
    const body = JSON.parse(result.out)
    expect(body).toMatchObject({ ok: false, file: path, rows: 0, warnings: [] })
    expect(body.errors[0]).toMatchObject({ line: 8, path: ['rows', 0, 'after', 0] })
    expect(typeof body.errors[0].column).toBe('number')
  })

  test('stdin is read for -', async () => {
    stdinText = file(row('a'))
    const result = await cli(['plan', 'check', '-'])
    expect(result.code).toBe(0)
    expect(result.out).toBe('ok: <stdin>, 1 rows\n')
  })

  test('an undeclared lane warns when project.yaml is beside docs/, and not when it is unknown', async () => {
    await mkdir(join(dir, 'repo', 'docs'), { recursive: true })
    await writeFile(join(dir, 'repo', 'project.yaml'), 'lanes:\n  apple: 1\n')
    const path = join(dir, 'repo', 'docs', 'plan.yaml')
    await writeFile(path, file(row('a', ['    lane: web'])))
    const known = await cli(['plan', 'check', path])
    expect(known.code).toBe(0)
    expect(known.out).toContain(`${path}: warning: row a: lane web is not declared`)
    stdinText = file(row('a', ['    lane: web']))
    expect((await cli(['plan', 'check', '-'])).out).not.toContain('warning')
  })

  test('a missing file is exit 2 and never throws', async () => {
    const result = await cli(['plan', 'check', join(dir, 'nope.yaml')])
    expect(result.code).toBe(2)
  })
})

describe('factory plan schema', () => {
  test('prints docs/plan.md, or it as json', async () => {
    const doc = await Bun.file(join(ROOT, 'docs', 'plan.md')).text()
    const plain = await cli(['plan', 'schema'])
    expect(plain.code).toBe(0)
    expect(plain.out).toBe(doc)
    expect(JSON.parse((await cli(['plan', 'schema', '--format', 'json'])).out)).toEqual({ format: doc })
  })

  test('issue schema names the plan file', async () => {
    expect((await cli(['issue', 'schema'])).out).toContain('docs/plan.yaml')
    expect((await cli(['issue', 'new', '--help'])).out).toContain('factory plan check docs/plan.yaml')
    expect(JSON.parse((await cli(['issue', 'schema', '--format', 'json'])).out).where.join('\n')).toContain(
      'docs/plan.yaml',
    )
  })
})

describe('plain forms', () => {
  test('issue list is one tab-separated line per Issue, and nothing for none', () => {
    const card = (ref: string, state: string, repoName: string, title: string) => ({ ref, state, repoName, title })
    const data = { issues: [card('issue_2', 'working', 'argo', 'Fix it'), card('issue_1', 'open', 'chat', 'Other')] }
    expect(issueListPlain(data)).toBe('issue_2\tworking\targo\tFix it\nissue_1\topen\tchat\tOther')
    expect(issueListPlain({ issues: [] })).toBe('')
  })

  test('artifact list is one tab-separated line per artifact, and nothing for none', () => {
    const artifact = (id: string, issueId: string, kind: string, title: string) => ({
      id,
      issueId,
      kind,
      title,
      createdAt: '2026-11-12T15:35:05.175Z',
    })
    const data = {
      artifacts: [
        artifact('artifact_2', 'issue_5', 'spec', 'A spec'),
        artifact('decision_1', 'issue_5', 'decision', 'Ask'),
      ],
    }
    expect(artifactListPlain(data)).toBe(
      'artifact_2\tissue_5\tspec\t2026-11-12\tA spec\ndecision_1\tissue_5\tdecision\t2026-11-12\tAsk',
    )
    expect(artifactListPlain({ artifacts: [] })).toBe('')
  })

  test('project show is a header, the plan error and warnings, then one line per row', () => {
    const base = { name: 'app', branch: 'main', leads: 2, syncedAt: '2026-11-10T09:00:00Z', planError: null }
    const rows = [
      { key: 'a', state: 'open', issue: 'issue_3', reason: null },
      { key: 'b', state: 'waiting', issue: null, reason: 'after app:a' },
    ]
    expect(projectShowPlain({ ...base, planError: 'bad', plan: { sha: null, warnings: ['w1'], rows } })).toBe(
      [
        'app branch=main leads=2 synced=2026-11-10T09:00:00Z',
        'planError: bad',
        'warning: w1',
        'a\topen\tissue_3\t-',
        'b\twaiting\t-\tafter app:a',
      ].join('\n'),
    )
    expect(
      projectShowPlain({ ...base, checks: { fast: 'make check-fast', full: 'make check', ci: true }, plan: null }),
    ).toBe(
      'app branch=main leads=2 synced=2026-11-10T09:00:00Z\nchecks: fast="make check-fast" full="make check" ci=true\nno plan',
    )
    expect(projectShowPlain({ ...base, plan: null })).toBe(
      'app branch=main leads=2 synced=2026-11-10T09:00:00Z\nno plan',
    )
  })
})
