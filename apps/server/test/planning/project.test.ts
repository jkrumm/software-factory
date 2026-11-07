import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseYamlText } from '../../src/adapters/planning/git-projects.ts'
import { defaultProject, parseProject } from '../../src/domains/planning/project.ts'
import { projectName, projectOf, type StoredProject, synced } from '../../src/domains/planning/sync.ts'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')

const yaml = (text: string): unknown => {
  const parsed = parseYamlText(text)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

describe('project.yaml', () => {
  test("the factory's own file (apiVersion factory/v2) parses, with its defaults filled in", async () => {
    const parsed = parseProject(yaml(await Bun.file(join(ROOT, 'project.yaml')).text()), 'software-factory')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.project.leads).toBe(1)
    expect(parsed.project.ship).toEqual([{ paths: ['**'], via: 'pr' }])
    expect(parsed.project.signals.github?.author).toBe('jkrumm')
    expect(parsed.project.deploy.targets[0]?.verify).toBe('make verify')
  })

  test('leads, slots.run and signals are read; jobs and ticktick are accepted and dropped', () => {
    const parsed = parseProject(
      yaml(
        [
          'apiVersion: factory/v2',
          'name: weatherorb',
          'leads: 2',
          'slots: { run: 45m }',
          'signals: { kuma: [weatherorb-web] }',
          'jobs: [deps]',
          'ticktick: { list: WeatherOrb }',
        ].join('\n'),
      ),
      'weatherorb',
    )
    expect(parsed).toMatchObject({ ok: true, project: { leads: 2, slots: { run: '45m' } } })
    expect(parsed.ok && 'jobs' in parsed.project).toBe(false)
  })

  test('a typo, a wrong version, a name that is not the directory and a bad value are refused with the reason', () => {
    const base = 'apiVersion: factory/v2\nname: x\n'
    expect(parseProject(yaml(`${base}lead: 2`), 'x')).toMatchObject({
      ok: false,
      message: expect.stringContaining('lead'),
    })
    expect(parseProject(yaml('apiVersion: factory/v1\nname: x'), 'x')).toMatchObject({ ok: false })
    expect(parseProject(yaml(`${base}leads: 9`), 'x')).toMatchObject({
      ok: false,
      message: expect.stringContaining('leads'),
    })
    expect(parseProject(yaml(base), 'other')).toEqual({
      ok: false,
      message: 'name is "x", the directory is "other"',
    })
    expect(parseProject(yaml(`${base}slots: { run: 10s }`), 'x')).toMatchObject({ ok: false })
  })

  test('duplicate keys and several documents are refused when the file is read; a merge key stays a plain key', () => {
    expect(parseYamlText('a: 1\na: 2\n')).toMatchObject({ ok: false })
    expect(parseYamlText('base: &b {x: 1}\nm:\n  <<: *b\n')).toMatchObject({
      ok: true,
      value: { m: { '<<': { x: 1 } } },
    })
    expect(parseYamlText('a: 1\n---\nb: 2\n')).toMatchObject({ ok: false })
  })
})

describe('sync', () => {
  const read = (project: unknown, plan: unknown = { state: 'absent' }) => ({
    branch: 'origin/main',
    project: project as never,
    plan: plan as never,
  })
  const at = new Date('2026-11-07T10:00:00Z')
  const sync = (previous: StoredProject | null, input: ReturnType<typeof read>) =>
    synced({ previous, name: 'x', directory: 'x', repo: '/src/x', read: input, now: at })

  test('no project.yaml: the defaults, one lead, no deploy', () => {
    const stored = sync(null, read({ state: 'absent' }))
    expect(stored).toMatchObject({ source: 'defaults', projectError: null, plan: null, branch: 'origin/main' })
    expect(stored.project).toEqual(defaultProject('x'))
  })

  test('a file that stops parsing keeps the last valid content and records the error once per content', () => {
    const good = sync(null, read({ state: 'text', sha: 'a', value: { apiVersion: 'factory/v2', name: 'x', leads: 3 } }))
    expect(good).toMatchObject({ source: 'file', projectSha: 'a' })
    expect(good.project.leads).toBe(3)
    const broken = sync(
      good,
      read({ state: 'text', sha: 'b', value: { apiVersion: 'factory/v2', name: 'x', leads: 99 } }),
    )
    expect(broken.project.leads).toBe(3)
    expect(broken.projectError).toMatchObject({ sha: 'b', message: expect.stringContaining('leads') })
    const fixed = sync(
      broken,
      read({ state: 'text', sha: 'c', value: { apiVersion: 'factory/v2', name: 'x', leads: 4 } }),
    )
    expect(fixed).toMatchObject({ projectError: null, projectSha: 'c' })
  })

  test('a plan that stops parsing keeps the last valid plan; a deleted plan is no plan', () => {
    const plan = { version: 1, rows: [{ key: 'a', title: 'A', facts: { why: 'y' } }] }
    const withPlan = sync(null, read({ state: 'absent' }, { state: 'text', sha: 'p1', value: plan }))
    expect(withPlan.plan?.rows).toHaveLength(1)
    const broken = sync(withPlan, read({ state: 'absent' }, { state: 'text', sha: 'p2', value: { version: 2 } }))
    expect(broken.plan?.rows).toHaveLength(1)
    expect(broken.planError?.sha).toBe('p2')
    const gone = sync(broken, read({ state: 'absent' }))
    expect(gone).toMatchObject({ plan: null, planError: null })
  })

  test('a second directory of a name keeps its own key; a stored repo keeps its name', () => {
    const taken = new Map([['app', '/a/app']])
    expect(projectName('app', '/a/app', taken)).toBe('app')
    expect(projectName('app', '/b/app', taken)).toMatch(/^app~[0-9a-f]{8}$/)
  })

  test('an Issue repo is a project by name, by path, or by a worktree below the path (the longest wins)', () => {
    const p = (name: string, repo: string) => ({ name, repo }) as StoredProject
    const projects = [p('a', '/src/a'), p('ab', '/src/a/b')]
    expect(projectOf(projects, 'a')?.name).toBe('a')
    expect(projectOf(projects, '/src/a')?.name).toBe('a')
    expect(projectOf(projects, '/src/a/.claude/worktrees/x')?.name).toBe('a')
    expect(projectOf(projects, '/src/a/b/c')?.name).toBe('ab')
    expect(projectOf(projects, '/src/other')).toBeUndefined()
  })
})
