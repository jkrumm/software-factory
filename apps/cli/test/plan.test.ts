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

  test('a file over the byte limit is an error and is not parsed', async () => {
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

  test('a plan row with opus and no why still files, and plan check warns naming the row', async () => {
    const opus = ['    seat:', '      tier: opus', '      effort: high']
    const said = await checkText(
      file(
        row('a', opus),
        row('b', [...opus, '      why: a schema the next rows build on']),
        row('c', ['    seat:', '      role: lead', '      moveUp: true']),
      ),
      'seat.yaml',
    )
    expect(said.code).toBe(0)
    expect(said.out).toContain(`${said.path}: warning: row a: a seat above the lead row has no seat.why`)
    expect(said.out).toContain('seat: {role: lead, moveUp: true}')
    expect(said.out.match(/warning/g)).toHaveLength(1)
    expect(said.out).toContain('ok: ')
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
    expect(
      projectShowPlain({
        ...base,
        projectWarnings: ['leads is 100, above the most a repo or lane takes: clamped to 64'],
        plan: null,
      }),
    ).toBe(
      'app branch=main leads=2 synced=2026-11-10T09:00:00Z\nprojectWarning: leads is 100, above the most a repo or lane takes: clamped to 64\nno plan',
    )
    expect(projectShowPlain({ ...base, plan: null })).toBe(
      'app branch=main leads=2 synced=2026-11-10T09:00:00Z\nno plan',
    )
  })
})

describe('rebasing the plan file', () => {
  const DRIVER = `bun ${join(ROOT, 'apps/cli/bin/factory.ts')} plan merge %O %A %B`
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd, stdout: 'pipe', stderr: 'pipe' },
    )
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const rebase = (cwd: string) => git(cwd, '-c', `merge.plan.driver=${DRIVER}`, 'rebase', 'master')

  /** a repo with the base plan on master, `branch` with its text and master with its own after it */
  async function fork(name: string, texts: { base: string; branch: string; master: string }) {
    const repo = await mkdtemp(join(dir, `${name}-`))
    const path = join(repo, 'docs/plan.yaml')
    await mkdir(join(repo, 'docs'))
    await writeFile(join(repo, '.gitattributes'), await Bun.file(join(ROOT, '.gitattributes')).text())
    await writeFile(path, texts.base)
    git(repo, 'init', '-q', '-b', 'master')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', 'branch')
    await writeFile(path, texts.branch)
    git(repo, 'commit', '-qam', 'branch')
    git(repo, 'checkout', '-q', 'master')
    await writeFile(path, texts.master)
    git(repo, 'commit', '-qam', 'master')
    git(repo, 'checkout', '-q', 'branch')
    return { repo, path }
  }

  test('the repo declares docs/plan.yaml an append-only aggregator for the plan driver', async () => {
    const attributes = await Bun.file(join(ROOT, '.gitattributes')).text()
    expect(attributes).toMatch(/^docs\/plan\.yaml\s+merge=plan$/m)
  })

  test('two branches appending rows that share lines rebase clean and keep every row whole', async () => {
    const { repo, path } = await fork('append', {
      base: file(row('a')),
      branch: file(row('a'), row('b')),
      master: file(row('a'), row('c')),
    })
    expect(rebase(repo).code).toBe(0)
    expect(await Bun.file(path).text()).toBe(file(row('a'), row('c'), row('b')))
    expect((await cli(['plan', 'check', path])).code).toBe(0)
  })

  test('master editing an earlier row does not clash with the branch appending', async () => {
    const { repo, path } = await fork('edit-master', {
      base: file(row('a'), row('z')),
      branch: file(row('a'), row('z'), row('b')),
      master: file(row('a', ['    after: [z]']), row('z')),
    })
    expect(rebase(repo).code).toBe(0)
    expect(await Bun.file(path).text()).toBe(file(row('a', ['    after: [z]']), row('z'), row('b')))
  })

  test('both sides editing the same row stays a conflict', async () => {
    const { repo, path } = await fork('clash', {
      base: file(row('a', ['    after: [z]']), row('z')),
      branch: file(row('a', ['    after: [y]']), row('z')),
      master: file(row('a', ['    after: [x]']), row('z')),
    })
    expect(rebase(repo).code).not.toBe(0)
    expect(await Bun.file(path).text()).toContain('<<<<<<<')
  })
})
