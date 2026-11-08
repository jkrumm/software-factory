import { expect, test } from 'bun:test'
import { projectFileProjects } from '../../src/app/quality-projects.ts'
import { parseProject } from '../../src/domains/planning/project.ts'
import type { StoredProject } from '../../src/domains/planning/sync.ts'
import type { Projects } from '../../src/domains/quality/ports.ts'
import { ok } from '../../src/kernel/result.ts'

const MAKEFILE: Projects = {
  checksOf: async () => ok({ windowMs: 5, deployMode: 'make', makeVerify: true, probes: [] }),
}

function stored(source: StoredProject['source'], yaml: Record<string, unknown> = {}): StoredProject {
  const parsed = parseProject({ apiVersion: 'factory/v2', name: 'app', ...yaml }, 'app')
  if (!parsed.ok) throw new Error(parsed.message)
  return {
    name: 'app',
    repo: '/roots/app',
    source,
    project: parsed.project,
    projectSha: null,
    projectError: null,
    plan: null,
    planSha: null,
    planError: null,
    planWarnings: [],
    branch: 'master',
    syncedAt: null,
  }
}

const projectsOf = (...rows: StoredProject[]) =>
  projectFileProjects({
    uow: {
      run: async (work) => work({ planning: { projects: async () => rows } as never }),
      inTransaction: () => false,
    },
    fallback: MAKEFILE,
  })

test('deploy mode auto: the file’s mode and hold, and make verify from its target, never make version', async () => {
  const projects = projectsOf(
    stored('file', {
      deploy: { mode: 'auto', hold: '10m', targets: [{ name: 'prod', host: 'vps', verify: 'make verify' }] },
    }),
  )
  expect(await projects.checksOf('/roots/app')).toEqual({
    ok: true,
    value: { windowMs: 600_000, deployMode: 'auto', makeVerify: true, probes: [] },
  })
})

test('a worktree below the repo is the repo; a URL target and the file’s probes are probes', async () => {
  const projects = projectsOf(
    stored('file', {
      deploy: {
        mode: 'none',
        hold: '30s',
        targets: [{ name: 'web', host: 'vps', verify: 'https://app.example.com/health' }],
        probes: [{ name: 'api', http: 'https://api.example.com/health', expect: 204 }],
      },
    }),
  )
  expect(await projects.checksOf('/roots/app/.claude/worktrees/x')).toEqual({
    ok: true,
    value: {
      windowMs: 30_000,
      deployMode: 'none',
      makeVerify: false,
      probes: [
        { name: 'web', http: 'https://app.example.com/health', expect: 200 },
        { name: 'api', http: 'https://api.example.com/health', expect: 204 },
      ],
    },
  })
})

test('mode make stays make: a missing version target is the proof’s red, not hidden here', async () => {
  const projects = projectsOf(stored('file', { deploy: { mode: 'make', hold: '1m' } }))
  expect(await projects.checksOf('/roots/app')).toMatchObject({
    ok: true,
    value: { deployMode: 'make', windowMs: 60_000, makeVerify: true },
  })
})

test('a file that names no target leaves verify to the Makefile', async () => {
  const projects = projectsOf(stored('file'))
  expect(await projects.checksOf('/roots/app')).toEqual({
    ok: true,
    value: { windowMs: 0, deployMode: 'none', makeVerify: true, probes: [] },
  })
})

test('no project.yaml, or no project at all: the Makefile, as before', async () => {
  const expected = ok({ windowMs: 5, deployMode: 'make' as const, makeVerify: true, probes: [] })
  expect(await projectsOf(stored('defaults')).checksOf('/roots/app')).toEqual(expected)
  expect(await projectsOf().checksOf('/roots/app')).toEqual(expected)
})

test('a target that verifies by another make target is carried, not dropped', async () => {
  const projects = projectsOf(
    stored('file', {
      deploy: {
        mode: 'auto',
        targets: [
          { name: 'a', host: 'mini', verify: 'make verify-apple' },
          { name: 'b', host: 'mini', verify: 'make verify-apple' },
        ],
      },
    }),
  )
  expect(await projects.checksOf('/roots/app')).toMatchObject({
    ok: true,
    value: { makeVerify: false, makeTargets: ['verify-apple'] },
  })
})
