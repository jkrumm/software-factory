import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseYamlText } from '../../src/adapters/planning/git-projects.ts'
import { defaultProject, parseProject, ProjectFile } from '../../src/domains/planning/project.ts'
import { signalsView } from '../../src/domains/planning/signals.ts'
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
    expect(parsed.project.leads).toBe(12)
    expect(parsed.project.ship).toEqual([{ paths: ['**'], via: 'pr' }])
    expect(parsed.project.signals.github?.author).toBe('jkrumm')
    expect(parsed.project.deploy.targets[0]?.verify).toBe('make verify')
    expect(parsed.project.checks).toEqual({ fast: 'make check-fast', full: 'make check', ci: true })
  })

  test('deploy.paths: empty by default, globs accepted, an empty or non-string entry refused', () => {
    const parse = (paths: string) =>
      parseProject(yaml(`apiVersion: factory/v2\nname: lab\ndeploy: { paths: ${paths} }`), 'lab')
    expect(defaultProject('lab').deploy.paths).toEqual([])
    const set = parse("['apps/**', Makefile]")
    expect(set.ok && set.project.deploy.paths).toEqual(['apps/**', 'Makefile'])
    for (const bad of ["['']", '[1]', 'apps']) expect(parse(bad).ok).toBe(false)
  })

  test('checks: none by default (one make check), tiers fill full and ci, anything but a make target is refused', () => {
    const parse = (checks: string) => parseProject(yaml(`apiVersion: factory/v2\nname: lab\nchecks: ${checks}`), 'lab')
    expect(defaultProject('lab').checks).toBeNull()
    const tiers = parse('{ fast: make check-fast }')
    expect(tiers.ok && tiers.project.checks).toEqual({ fast: 'make check-fast', full: 'make check', ci: false })
    const sharded = parse('{ fast: make check-fast, full: make ci-full, ci: true }')
    expect(sharded.ok && sharded.project.checks).toEqual({ fast: 'make check-fast', full: 'make ci-full', ci: true })
    for (const bad of [
      '{ full: make check }',
      '{ fast: bun test }',
      '{ fast: "make a; rm -rf /" }',
      '{ fast: make a, x: 1 }',
    ])
      expect(parse(bad).ok).toBe(false)
    // a stored project reads back through the same schema, and an old stored row has no checks at all
    const stored = ProjectFile.parse(sharded.ok ? sharded.project : null)
    expect(stored.checks?.ci).toBe(true)
    expect(ProjectFile.parse({ apiVersion: 'factory/v2', name: 'lab' }).checks).toBeNull()
  })

  test('lanes cap the leads of a resource class: none by default, a lane name and a cap of 1 to 64', () => {
    const parse = (lanes: string) => parseProject(yaml(`apiVersion: factory/v2\nname: lab\nlanes: ${lanes}`), 'lab')
    expect(defaultProject('lab').lanes).toEqual({})
    const ok = parse('{ apple: 1, web-ui: 3 }')
    expect(ok.ok && ok.project.lanes).toEqual({
      apple: { leads: 1, memoryMib: null },
      'web-ui': { leads: 3, memoryMib: null },
    })
    const heavy = parse('{ apple: { leads: 1, memory: 18GiB }, sim: { leads: 2, memory: 512MiB }, web: { leads: 2 } }')
    expect(heavy.ok && heavy.project.lanes).toEqual({
      apple: { leads: 1, memoryMib: 18_432 },
      sim: { leads: 2, memoryMib: 512 },
      web: { leads: 2, memoryMib: null },
    })
    expect(parse('{ apple: { leads: 1, memory: 18 } }').ok).toBe(false)
    expect(parse('{ apple: { leads: 1, memory: 2000000GiB } }').ok).toBe(false)
    expect(parse('{ apple: { leads: 1, ram: 4GiB } }').ok).toBe(false)
    expect(parse('{ apple: 0 }').ok).toBe(false)
    expect(parse('{ apple: 65 }').ok).toBe(true)
    expect(parse('{ apple: 1.5 }').ok).toBe(false)
    expect(parse('{ Apple: 1 }').ok).toBe(false)
  })

  test('hygiene.check defaults on; false needs a reason, and an unknown key is an error', () => {
    const parse = (hygiene: string) =>
      parseProject(yaml(`apiVersion: factory/v2\nname: lab\nhygiene: ${hygiene}`), 'lab')
    expect(defaultProject('lab').hygiene).toEqual({ check: true, probes: [] })
    const off = parse('{ check: false, reason: needs the owner library }')
    expect(off.ok && off.project.hygiene).toEqual({ check: false, reason: 'needs the owner library', probes: [] })
    const bare = parse('{ check: false }')
    expect(bare.ok).toBe(false)
    expect(!bare.ok && bare.message).toContain('hygiene.reason')
    expect(parse('{ chek: false }').ok).toBe(false)
  })

  test('hygiene.probes are {name, target} with a slug target, never a shell string', () => {
    const parse = (probes: string) =>
      parseProject(yaml(`apiVersion: factory/v2\nname: lab\nhygiene: { probes: ${probes} }`), 'lab')
    const ok = parse('[{ name: demo, target: demo-check }]')
    expect(ok.ok && ok.project.hygiene.probes).toEqual([{ name: 'demo', target: 'demo-check' }])
    for (const bad of [
      '[{ name: demo, target: "make x; rm -rf /" }]',
      '[{ name: demo, target: "../x" }]',
      '[{ name: demo, target: Demo }]',
      '[{ name: demo, target: "" }]',
      '[{ name: "a b", target: x }]',
      '[{ name: demo }]',
      '[{ name: demo, target: x, cmd: y }]',
      '[{ name: demo, target: a }, { name: demo, target: b }]',
    ]) {
      expect(parse(bad).ok).toBe(false)
    }
  })

  test('doctor is `make <target>` or absent, never a shell string', () => {
    const parse = (doctor: string) => parseProject(yaml(`apiVersion: factory/v2\nname: lab\ndoctor: ${doctor}`), 'lab')
    expect(defaultProject('lab').doctor).toBeNull()
    const ok = parse('make doctor')
    expect(ok.ok && ok.project.doctor).toBe('make doctor')
    for (const bad of ['"scripts/doctor.sh"', '"make doctor; rm -rf /"', '"make"', '""', '[make doctor]']) {
      expect(parse(bad).ok).toBe(false)
    }
  })

  test("host is a slug naming the host the project's alerts sit on", () => {
    const parse = (host: string) => parseProject(yaml(`apiVersion: factory/v2\nname: lab\nhost: ${host}`), 'lab')
    const ok = parse('macmini')
    expect(ok.ok && ok.project.host).toBe('macmini')
    expect(parse('Not A Slug').ok).toBe(false)
    expect(defaultProject('lab').host).toBeUndefined()
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
    expect(parseProject(yaml(`${base}leads: 0`), 'x')).toMatchObject({
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

  test('no project.yaml: the defaults, no cap on leads, no deploy', () => {
    const stored = sync(null, read({ state: 'absent' }))
    expect(stored).toMatchObject({ source: 'defaults', projectError: null, plan: null, branch: 'origin/main' })
    expect(stored.project).toEqual(defaultProject('x'))
    expect(stored.project.leads).toBe(64)
  })

  test('a project that states no leads gets 64 (no cap beyond the host); the bound is 64 for the repo and for a lane', () => {
    const base = 'apiVersion: factory/v2\nname: x\n'
    expect(parseProject(yaml(base), 'x')).toMatchObject({ ok: true, project: { leads: 64 }, warnings: [] })
    expect(parseProject(yaml(`${base}leads: 64\nlanes: { apple: 64, sim: { leads: 64 } }`), 'x')).toMatchObject({
      ok: true,
      project: { leads: 64, lanes: { apple: { leads: 64 }, sim: { leads: 64 } } },
      warnings: [],
    })
  })

  test('a leads above the bound is clamped and named, never a refused file; other bad values still refuse it', () => {
    const base = 'apiVersion: factory/v2\nname: x\n'
    const parsed = parseProject(
      yaml(`${base}leads: 100\nlanes: { apple: 70, sim: { leads: 65, memory: 2GiB }, web: 2 }`),
      'x',
    )
    expect(parsed).toMatchObject({
      ok: true,
      project: { leads: 64, lanes: { apple: { leads: 64 }, sim: { leads: 64, memoryMib: 2048 }, web: { leads: 2 } } },
    })
    expect(parsed.ok && parsed.warnings).toEqual([
      'leads is 100, above the most a repo or lane takes: clamped to 64',
      'lanes.apple is 70, above the most a repo or lane takes: clamped to 64',
      'lanes.sim.leads is 65, above the most a repo or lane takes: clamped to 64',
    ])
    expect(parseProject(yaml(`${base}leads: 100.5`), 'x')).toMatchObject({ ok: false })
    expect(parseProject(yaml(`${base}leads: many`), 'x')).toMatchObject({ ok: false })
    const stored = sync(
      null,
      read({ state: 'text', sha: 'a', value: { apiVersion: 'factory/v2', name: 'x', leads: 12000 } }),
    )
    expect(stored).toMatchObject({ projectError: null, projectSha: 'a', project: { leads: 64 } })
    expect(stored.projectWarnings).toEqual(['leads is 12000, above the most a repo or lane takes: clamped to 64'])
    // a later file with nothing to clamp clears the warning
    const fixed = sync(
      stored,
      read({ state: 'text', sha: 'b', value: { apiVersion: 'factory/v2', name: 'x', leads: 12 } }),
    )
    expect(fixed.projectWarnings).toEqual([])
  })

  test('a file that stops parsing keeps the last valid content and records the error once per content', () => {
    const good = sync(null, read({ state: 'text', sha: 'a', value: { apiVersion: 'factory/v2', name: 'x', leads: 3 } }))
    expect(good).toMatchObject({ source: 'file', projectSha: 'a' })
    expect(good.project.leads).toBe(3)
    const broken = sync(
      good,
      read({ state: 'text', sha: 'b', value: { apiVersion: 'factory/v2', name: 'x', leads: 0 } }),
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

describe('what intake hears', () => {
  const stored = (raw: unknown, source: 'file' | 'defaults' = 'file'): StoredProject => {
    const parsed = parseProject(raw, 'x')
    if (!parsed.ok) throw new Error(parsed.message)
    return { name: 'x', repo: '/src/x', source, project: parsed.project } as StoredProject
  }

  test('work: true keeps a repo with a project.yaml a work repo', () => {
    const view = signalsView(stored({ apiVersion: 'factory/v2', name: 'x', work: true }))
    expect(view.work).toBe(true)
    expect(signalsView(stored({ apiVersion: 'factory/v2', name: 'x' })).work).toBe(false)
  })

  test('the automatic sources a project lists, its heal rules in milliseconds, and a repo without a file is a work repo', () => {
    const view = signalsView(
      stored({
        apiVersion: 'factory/v2',
        name: 'x',
        host: 'macmini',
        signals: { github: { label: 'factory', checks: true, author: 'me', since: '2026-11-07' }, launchd: ['com.x'] },
        heal: [{ when: 'kuma.down', grace: '5m', runbook: 'make restart', max: 2 }],
      }),
    )
    expect(view).toEqual({
      repo: 'x',
      work: false,
      host: 'macmini',
      sources: ['github', 'checks', 'launchd'],
      github: { label: 'factory', author: 'me', since: '2026-11-07', checks: true },
      launchd: ['com.x'],
      heal: [{ when: 'kuma.down', graceMs: 300_000, runbook: 'make restart', max: 2 }],
    })
    const work = signalsView(stored({ apiVersion: 'factory/v2', name: 'x' }, 'defaults'))
    expect(work).toMatchObject({ work: true, host: null, sources: [], github: null, launchd: [], heal: [] })
  })
})
