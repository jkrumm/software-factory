import { describe, expect, test } from 'bun:test'
import { defaultProject } from '@software-factory/contract/project'
import { storedChecks } from '../../src/app/leads-checks.ts'
import type { StoredProject } from '../../src/domains/planning/sync.ts'

const stored = (name: string, source: 'file' | 'defaults', patch: Record<string, unknown> = {}): StoredProject =>
  ({
    name,
    repo: `/src/${name}`,
    source,
    project: { ...defaultProject(name), ...patch },
  }) as unknown as StoredProject

const checksOf = (projects: StoredProject[], workGhConfigDir: string | null) =>
  storedChecks(
    {
      run: async (fn: never) => (fn as (tx: unknown) => unknown)({ planning: { projects: async () => projects } }),
    } as never,
    {
      workGhConfigDir,
    },
  )

const envOf = async (checks: ReturnType<typeof checksOf>, repo: string) => {
  const env = await checks.env(repo)
  if (!env.ok) throw new Error('env failed')
  return env.value
}

describe("a lead's session env", () => {
  const projects = [
    stored('own', 'file', { env: { ORB_FORMAT: 'json' } }),
    stored('plain', 'defaults'),
    stored('flagged', 'file', { work: true }),
    stored('claimed', 'file', { work: true, env: { GH_CONFIG_DIR: '/own/gh' } }),
  ]

  test('a work repo (no project.yaml, or work: true) runs gh as the work account', async () => {
    const checks = checksOf(projects, '/cfg/gh-work')
    expect(await envOf(checks, '/src/plain')).toEqual({ GH_CONFIG_DIR: '/cfg/gh-work' })
    expect(await envOf(checks, '/src/flagged')).toEqual({ GH_CONFIG_DIR: '/cfg/gh-work' })
  })

  test("the project's own GH_CONFIG_DIR wins", async () => {
    expect(await envOf(checksOf(projects, '/cfg/gh-work'), '/src/claimed')).toEqual({ GH_CONFIG_DIR: '/own/gh' })
  })

  test("an own repo gets its project's env alone, and no host setting adds nothing", async () => {
    expect(await envOf(checksOf(projects, '/cfg/gh-work'), '/src/own')).toEqual({ ORB_FORMAT: 'json' })
    expect(await envOf(checksOf(projects, null), '/src/plain')).toEqual({})
  })
})
