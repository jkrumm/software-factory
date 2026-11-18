import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Tools } from '../../src/adapters/hygiene/git.ts'
import { projectProbe } from '../../src/adapters/hygiene/probes/project.ts'

const TOOLS = {} as Tools
const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

let base: string
let counter = 0

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ID } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
}

/** The files of a repo named `repo-a` (or `name`), committed, as a main checkout. */
function repo(files: Record<string, string>, name = 'repo-a'): string {
  const dir = join(base, `case-${++counter}`, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git(dir, ['init', '-q', '-b', 'master'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

const GOOD = [
  'apiVersion: factory/v2',
  'name: repo-a',
  'deploy:',
  '  mode: make',
  '  targets:',
  '    - { name: mini, verify: make verify }',
  'checks: { fast: make check-fast, full: make check }',
  'doctor: make doctor',
  '',
].join('\n')
const MAKEFILE = 'check-fast:\n\ttrue\ncheck:\n\ttrue\ndeploy:\n\ttrue\nverify:\n\ttrue\ndoctor:\n\ttrue\n'

const lines = async (files: Record<string, string>) => {
  const outcome = await projectProbe(TOOLS, repo(files))
  return { outcome, evidence: outcome.findings[0]?.lines ?? [] }
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hygiene-project-')))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('projectProbe', () => {
  test('skips a repo with no project.yaml', async () => {
    const outcome = await projectProbe(TOOLS, repo({ Makefile: MAKEFILE }))
    expect(outcome.outcome).toBe('skipped')
  })

  test('a file that passes the lint is clean', async () => {
    const outcome = await projectProbe(TOOLS, repo({ 'project.yaml': GOOD, Makefile: MAKEFILE }))
    expect(outcome.outcome).toBe('clean')
  })

  test('a broken file is a finding with its line', async () => {
    const { outcome, evidence } = await lines({ 'project.yaml': 'apiVersion: factory/v2\nname: repo-a\nbogus: 1\n' })
    expect(outcome.outcome).toBe('found')
    expect(outcome.findings[0]).toMatchObject({
      probe: 'project',
      key: 'project:project.yaml',
      title: 'Hygiene: project.yaml has problems',
    })
    expect(evidence).toEqual(['project.yaml:3: unknown key bogus'])
  })

  test('a file that is not YAML does not throw', async () => {
    const { outcome } = await lines({ 'project.yaml': 'a: [unclosed\n' })
    expect(outcome.outcome).toBe('found')
    expect(outcome.findings[0]?.count).toBeGreaterThan(0)
  })

  test('a retired key is a warning finding', async () => {
    const text = GOOD.replace('deploy:\n', 'deploy:\n  migrations: [db]\n')
    const { evidence } = await lines({ 'project.yaml': text, Makefile: MAKEFILE })
    expect(evidence).toEqual([
      'project.yaml:4: deploy.migrations is retired: the factory accepts it and reads nothing from it; remove it',
    ])
  })

  test('a make target the Makefile lacks', async () => {
    const { evidence } = await lines({ 'project.yaml': GOOD, Makefile: MAKEFILE.replace('check-fast:\n\ttrue\n', '') })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toContain('make check-fast: the Makefile has no target check-fast')
  })

  test('a header citing a missing document', async () => {
    const text = `# the reason is in docs/missing.md\n${GOOD}`
    const { evidence } = await lines({ 'project.yaml': text, Makefile: MAKEFILE })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toContain('project.yaml:1: a comment cites docs/missing.md, which does not exist')
    const green = await projectProbe(TOOLS, repo({ 'project.yaml': text, Makefile: MAKEFILE, 'docs/missing.md': 'x' }))
    expect(green.outcome).toBe('clean')
  })

  test('a doctor target the file does not name', async () => {
    const { evidence } = await lines({ 'project.yaml': GOOD.replace('doctor: make doctor\n', ''), Makefile: MAKEFILE })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toContain('the Makefile defines `doctor` but the file does not name it')
  })

  test('a verify target no deploy target names', async () => {
    const text = GOOD.replace('  targets:\n    - { name: mini, verify: make verify }\n', '')
    const { evidence } = await lines({ 'project.yaml': text, Makefile: MAKEFILE })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toContain('no deploy target names `verify: make verify`')
    const none = await projectProbe(
      TOOLS,
      repo({ 'project.yaml': text.replace('mode: make', 'mode: none'), Makefile: MAKEFILE }),
    )
    expect(none.outcome).toBe('clean')
  })

  test('targets under a mode that deploys nothing', async () => {
    const { evidence } = await lines({ 'project.yaml': GOOD.replace('mode: make', 'mode: none'), Makefile: MAKEFILE })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toContain('deploy.mode is none')
  })

  test('a constant without its reason, and with one', async () => {
    const bare = `${GOOD}leads: 12\nbudgets:\n  fast: 5m\n`
    const { evidence } = await lines({ 'project.yaml': bare, Makefile: MAKEFILE })
    expect(evidence.map((line) => line.split(' with no')[0])).toEqual([
      'project.yaml:9: leads is set to 12',
      'project.yaml:11: budgets.fast is set to 5m',
    ])
    const reasoned = `${GOOD}leads: 12 # one signing keychain\n# the throughput loop\nbudgets:\n  fast: 5m\n`
    const green = await projectProbe(TOOLS, repo({ 'project.yaml': reasoned, Makefile: MAKEFILE }))
    expect(green.outcome).toBe('clean')
  })

  test('a leads whose comment names the merge window is a finding that points at factory merge-lock', async () => {
    const windowed = `${GOOD}leads: 12 # the merge window\n`
    const { evidence } = await lines({ 'project.yaml': windowed, Makefile: MAKEFILE })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toContain('project.yaml:9: leads is 12 for a resource the factory already models')
    expect(evidence[0]).toContain('factory merge-lock')
  })

  test('a citation of a sibling repo resolves beside the main checkout, also from a linked worktree', async () => {
    const cited = `${GOOD}# the reason is in repo-b docs/why.md\n`
    const main = repo({ 'project.yaml': cited, Makefile: MAKEFILE })
    const sibling = join(dirname(main), 'repo-b')
    mkdirSync(join(sibling, 'docs'), { recursive: true })
    writeFileSync(join(sibling, 'project.yaml'), 'apiVersion: factory/v2\nname: repo-b\n')
    writeFileSync(join(sibling, 'docs', 'why.md'), 'why\n')
    expect((await projectProbe(TOOLS, main)).outcome).toBe('clean')
    // the hygiene pass reads a throwaway worktree that lives elsewhere: the sibling is still found beside the main checkout
    const linked = join(base, `throwaway-${++counter}`)
    git(main, ['worktree', 'add', '-q', '--detach', linked])
    expect((await projectProbe(TOOLS, linked)).outcome).toBe('clean')
  })

  test('the name is compared with the main checkout, also from a linked worktree', async () => {
    const main = repo({ 'project.yaml': GOOD, Makefile: MAKEFILE })
    const linked = join(dirname(main), 'throwaway-1a2b3c4-xyz')
    git(main, ['worktree', 'add', '-q', '--detach', linked])
    expect((await projectProbe(TOOLS, linked)).outcome).toBe('clean')
    const wrong = repo({ 'project.yaml': GOOD.replace('name: repo-a', 'name: repo-b'), Makefile: MAKEFILE })
    const outcome = await projectProbe(TOOLS, wrong)
    expect(outcome.findings[0]?.lines[0]).toContain('name is "repo-b", the repo is "repo-a"')
  })
})
