import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../src/run.ts'

const ROOT = join(import.meta.dir, '..', '..', '..')
let dir: string
let stdinText = ''

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-cli-project-')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function cli(argv: string[]) {
  let out = ''
  const code = await run(argv, {
    env: {},
    out: (text) => {
      out += text
    },
    err: () => {},
    stdin: () => Promise.resolve(stdinText),
    readFile: (path) => Bun.file(path).text(),
  })
  return { code, out }
}

/** A repo directory `<name>` holding the file and, when given, a Makefile and other files. */
async function repo(name: string, files: Record<string, string>): Promise<string> {
  const path = join(dir, name)
  await mkdir(path, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(path, file, '..'), { recursive: true })
    await writeFile(join(path, file), text)
  }
  return join(path, 'project.yaml')
}

describe('factory project check', () => {
  test("this repo's own project.yaml passes with no warning", async () => {
    const { code, out } = await cli(['project', 'check', join(ROOT, 'project.yaml')])
    expect(out).toBe(`ok: ${join(ROOT, 'project.yaml')}\n`)
    expect(code).toBe(0)
  })

  test('a typo under signals fails with its line and column, exit 2', async () => {
    const file = await repo('typo', {
      'project.yaml': ['apiVersion: factory/v2', 'name: typo', 'signals:', '  githb: { checks: true }', ''].join('\n'),
    })
    const { code, out } = await cli(['project', 'check', file, '--format', 'json'])
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      errors: [{ line: 4, column: 3, path: ['signals', 'githb'], message: 'signals: unknown key githb' }],
    })
    expect(code).toBe(2)
  })

  test('the plain form names the line of the typo', async () => {
    stdinText = ['apiVersion: factory/v2', 'name: typo', 'signals:', '  githb: { checks: true }', ''].join('\n')
    const { code, out } = await cli(['project', 'check', '-'])
    expect(out).toContain('<stdin>:4:3: signals: unknown key githb')
    expect(code).toBe(2)
  })

  test('warns on a retired key, a missing make target, a name that is not the repo and a comment citing a missing document', async () => {
    const file = await repo('lab', {
      Makefile: 'check:\n\ttrue\nverify deploy:\n\ttrue\n',
      'docs/here.md': '# here\n',
      'project.yaml': [
        '# keys: docs/here.md and docs/gone.md',
        'apiVersion: factory/v2',
        'name: lab2',
        'deploy:',
        '  mode: make',
        '  targets:',
        '    - { name: mini, host: mini, verify: make verify }',
        '  migrations: []',
        'checks: { fast: make check-fast } # the full gate is make check',
        '',
      ].join('\n'),
    })
    const { code, out } = await cli(['project', 'check', file, '--format', 'json'])
    expect(code).toBe(0)
    const answer = JSON.parse(out) as { ok: boolean; warnings: { line: number; message: string }[] }
    expect(answer.ok).toBe(true)
    expect(answer.warnings.map((w) => [w.line, w.message])).toEqual([
      [1, 'a comment cites docs/gone.md, which does not exist: point it at the document that holds the reason'],
      [3, 'name is "lab2", the repo is "lab": the factory refuses the file'],
      [8, 'deploy.migrations is retired: the factory accepts it and reads nothing from it; remove it'],
      [9, 'make check-fast: the Makefile has no target check-fast'],
    ])
  })

  test('a bare word on the line before a rule is no target of it', async () => {
    const file = await repo('bare', {
      Makefile: 'deploy\ncheck:\n\ttrue\n',
      'project.yaml': 'apiVersion: factory/v2\nname: bare\ndeploy: { mode: make }\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).toContain('warning: make deploy: the Makefile has no target deploy')
  })

  test('a leads above the bound is a warning at its line, not a problem', async () => {
    const file = await repo('wide', { 'project.yaml': 'apiVersion: factory/v2\nname: wide\nleads: 100\n' })
    const { code, out } = await cli(['project', 'check', file])
    expect(out).toContain(`${file}:3:1: warning: leads is 100`)
    expect(code).toBe(0)
  })
})

describe('factory project schema', () => {
  test('prints the author page offline; --format json adds the JSON Schema', async () => {
    const plain = await cli(['project', 'schema'])
    expect(plain.out).toStartWith('# project.yaml')
    expect(plain.out).toContain('| `deploy.hold` | duration |')
    const json = await cli(['project', 'schema', '--format', 'json'])
    const answer = JSON.parse(json.out) as { jsonSchema: { $id: string; properties: Record<string, unknown> } }
    expect(answer.jsonSchema.$id).toEndWith('/schema/project.schema.json')
    expect(Object.keys(answer.jsonSchema.properties)).toContain('checks')
  })
})
