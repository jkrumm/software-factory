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

  test("a worktree of a bare <name>.git is the repo <name> (a step host's copy)", async () => {
    const file = await repo('bare-src', {
      'project.yaml':
        'apiVersion: factory/v2\nname: lab3\ndeploy: { mode: make, targets: [{ name: mini, host: mini, verify: make verify }] }\nchecks: { fast: make check-fast } # reason\n',
      Makefile: 'check-fast:\n\ttrue\n',
    })
    const src = join(file, '..')
    const bare = join(dir, 'lab3.git')
    const sh = async (...cmd: string[]) => {
      const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
      if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')}: ${await new Response(proc.stderr).text()}`)
    }
    const git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com']
    await sh(...git, '-C', src, 'init', '-q')
    await sh(...git, '-C', src, 'add', '-A')
    await sh(...git, '-C', src, 'commit', '-q', '-m', 'x')
    await sh('git', 'clone', '-q', '--bare', src, bare)
    const tree = join(dir, 'step-copy')
    await sh('git', '-C', bare, 'worktree', 'add', '-q', '--detach', tree)
    const { out } = await cli(['project', 'check', join(tree, 'project.yaml')])
    expect(out).not.toContain('the repo is')
  })

  test("a step's make target the Makefile lacks is a warning", async () => {
    const file = await repo('stepper', {
      Makefile: 'test:\n\ttrue\n',
      'project.yaml': 'apiVersion: factory/v2\nname: stepper\nsteps: { unit: { make: test }, e2e: { make: tset } }\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).toContain('warning: make tset: the Makefile has no target tset')
    expect(out).not.toContain('make test:')
  })

  test('a bare word on the line before a rule is no target of it', async () => {
    const file = await repo('bare', {
      Makefile: 'deploy\ncheck:\n\ttrue\n',
      'project.yaml': 'apiVersion: factory/v2\nname: bare\ndeploy: { mode: make }\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).toContain('warning: make deploy: the Makefile has no target deploy')
  })

  test('a target an included file defines is no missing target', async () => {
    const file = await repo('includer', {
      Makefile: 'include $(REPO_DIR)/core/core.mk\n',
      'project.yaml': 'apiVersion: factory/v2\nname: includer\nchecks: { fast: make check-fast }\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).not.toContain('check-fast')
  })

  test('a leads above the bound is a warning at its line, not a problem', async () => {
    const file = await repo('wide', { 'project.yaml': 'apiVersion: factory/v2\nname: wide\nleads: 100\n' })
    const { code, out } = await cli(['project', 'check', file])
    expect(out).toContain(`${file}:3:1: warning: leads is 100`)
    expect(code).toBe(0)
  })

  test('a leads of 1 for a merge window is a warning that points at factory merge-lock, exit 0', async () => {
    const file = await repo('windowed', {
      'project.yaml': 'apiVersion: factory/v2\nname: windowed\nleads: 1 # the merge window serialises merges\n',
    })
    const { code, out } = await cli(['project', 'check', file])
    expect(out).toContain(`${file}:3:1: warning: leads is 1 for a resource the factory already models`)
    expect(out).toContain('factory merge-lock')
    expect(code).toBe(0)
  })

  test('a leads for a deploy queue points at factory deploy-lock', async () => {
    const file = await repo('queued', {
      'project.yaml': 'apiVersion: factory/v2\nname: queued\n# the deploy queue is one at a time\nleads: 2\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).toContain('factory deploy-lock')
  })

  test('a leads whose comment records no reason is a finding', async () => {
    const file = await repo('unreasoned', {
      'project.yaml': 'apiVersion: factory/v2\nname: unreasoned\nleads: 1 # no reason was recorded\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).toContain('records no reason')
  })

  test('a leads for a resource the factory does not model passes', async () => {
    const file = await repo('shared-licence', {
      'project.yaml':
        'apiVersion: factory/v2\nname: shared-licence\nleads: 2 # one floating licence per lead, two seats bought\n',
    })
    const { out } = await cli(['project', 'check', file])
    expect(out).not.toContain('already models')
    expect(out).not.toContain('records no reason')
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
