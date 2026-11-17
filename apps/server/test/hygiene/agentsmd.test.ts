import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools } from '../../src/adapters/hygiene/git.ts'

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const tools = defaultTools()
let base: string
let counter = 0

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ID, ...env } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** A committed repo with `files`; the probe reads the tracked files of this directory. */
function repo(files: Record<string, string>): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'master'])
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-hygiene-probe-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

import { agentsImports, agentsmdProbe, askRules } from '../../src/adapters/hygiene/probes/agentsmd.ts'

describe('agentsImports', () => {
  test('finds @path imports, ignores scopes, e-mail, code spans and fences', () => {
    const text = [
      '# Rules',
      '@docs/design.md',
      'See @./notes.md for more.',
      'Install `@docs/in-code.md` and @types/node, mail me@example.com.',
      '```',
      '@docs/in-fence.md',
      '```',
      'The package @scope/pkg is fine.',
    ].join('\n')
    expect(agentsImports(text)).toEqual([
      { line: 2, target: 'docs/design.md' },
      { line: 3, target: './notes.md' },
    ])
  })
})

describe('agentsImports managed block', () => {
  test('skips the basalt-ui managed block, still flags imports around it', () => {
    const text = [
      '@docs/before.md',
      '<!-- basalt:begin -->',
      '@./DESIGN.md',
      '<!-- basalt:end -->',
      '@docs/after.md',
    ].join('\n')
    expect(agentsImports(text)).toEqual([
      { line: 1, target: 'docs/before.md' },
      { line: 5, target: 'docs/after.md' },
    ])
  })

  test('an unclosed block hides the rest, a marker inside a fence is not a block', () => {
    expect(agentsImports('<!-- basalt:begin -->\n@./DESIGN.md')).toEqual([])
    expect(agentsImports('```\n<!-- basalt:begin -->\n```\n@docs/x.md')).toEqual([{ line: 4, target: 'docs/x.md' }])
  })
})

describe('askRules', () => {
  test('lists ask rules, treats missing as none and reports malformed JSON', () => {
    expect(askRules('{"permissions":{"ask":["Bash(git push:*)"]}}')).toEqual({ rules: ['Bash(git push:*)'] })
    expect(askRules('{"permissions":{"deny":["x"]}}')).toEqual({ rules: [] })
    expect(askRules('{ nope')).toEqual({ malformed: true })
  })
})

describe('agentsmdProbe', () => {
  test('red: CLAUDE.md, imports and ask rules are one finding each', async () => {
    const dir = repo({
      'AGENTS.md': '# A\n@docs/design.md\n',
      'sub/CLAUDE.md': '@AGENTS.md\n',
      '.claude/settings.json': '{"permissions":{"ask":["Bash(git push:*)"]}}',
    })
    const out = await agentsmdProbe(tools, dir)
    expect(out.outcome).toBe('found')
    expect(out.findings.map((f) => [f.key, f.title])).toEqual([
      ['agentsmd:claude-md', 'Hygiene: CLAUDE.md files in the repo'],
      ['agentsmd:imports', 'Hygiene: @imports in AGENTS.md'],
      ['agentsmd:ask-rules', 'Hygiene: ask rules in .claude/settings.json'],
    ])
    expect(out.findings[1]?.lines).toEqual(['AGENTS.md:2: @docs/design.md'])
  })

  test('green: a plain AGENTS.md and a settings file without ask rules', async () => {
    const dir = repo({
      'AGENTS.md': '# A\nuse @types/node\n',
      '.claude/settings.json': '{"permissions":{"deny":["x"]}}',
    })
    expect((await agentsmdProbe(tools, dir)).outcome).toBe('clean')
  })

  test('skipped: no agent files at all', async () => {
    expect((await agentsmdProbe(tools, repo({ 'a.txt': 'x' }))).outcome).toBe('skipped')
  })

  test('a malformed settings.json is one finding line', async () => {
    const out = await agentsmdProbe(tools, repo({ '.claude/settings.json': '{ nope' }))
    expect(out.findings.map((f) => [f.key, f.lines])).toEqual([
      ['agentsmd:ask-rules', ['.claude/settings.json: not valid JSON']],
    ])
  })
})
