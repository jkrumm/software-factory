import { readFile } from 'node:fs/promises'
import * as z from 'zod'
import type { RepoSignals } from '../../domains/intake/model.ts'
import type { ProjectSignals } from '../../domains/intake/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/**
 * No package of this rewrite yet reads the projects' `project.yaml` files, so the real list of projects and what
 * each hears is the orchestrator's to wire. Until then nothing is a project: every automatic signal is dropped with
 * `no_project`, and the owner's go nowhere. Named a stub on purpose.
 */
export const stubProjectSignals: ProjectSignals = {
  find: () => Promise.resolve(ok(null)),
  polled: () => Promise.resolve(ok([])),
}

const Heal = z.strictObject({
  when: z.string().regex(/^[a-z]+\.down$/),
  graceMs: z.number().int().min(1000).max(86_400_000),
  runbook: z.literal('make restart').nullable().default(null),
  max: z.number().int().min(1).max(5).default(1),
})

const Project = z.strictObject({
  repo: z.string().min(1),
  work: z.boolean().default(false),
  sources: z.array(z.string()).default([]),
  github: z
    .strictObject({
      label: z.string().default('factory'),
      author: z.string().nullable().default(null),
      since: z.string().nullable().default(null),
      checks: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  launchd: z.array(z.string()).default([]),
  heal: z.array(Heal).default([]),
})

/** A project hears the automatic sources its `signals:` configure: configuring `github` or `launchd` is listing it. */
function withSources(project: z.output<typeof Project>): RepoSignals {
  const sources = new Set(project.sources)
  if (project.github) sources.add('github')
  if (project.github?.checks) sources.add('checks')
  if (project.launchd.length > 0) sources.add('launchd')
  return { ...project, sources: [...sources] }
}

const File = z.strictObject({ projects: z.array(Project) })

/**
 * The projects from a JSON file (`FACTORY_INTAKE_PROJECTS_FILE`), re-read on every call so an edit takes at once. This is the
 * interim source the scenarios and a first deployment use; the `project.yaml` files replace it. A missing or bad file is an error
 * result, never an empty list: an intake that silently hears nothing is worse than one that says why.
 */
export function fileProjectSignals(path: string): ProjectSignals {
  const read = async () => {
    try {
      return ok(File.parse(JSON.parse(await readFile(path, 'utf8'))).projects.map(withSources))
    } catch (error) {
      return err(portError('unreadable', `${path}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  return {
    async find(repo) {
      const all = await read()
      return all.ok ? ok(all.value.find((project) => project.repo === repo) ?? null) : all
    },
    async polled() {
      return read()
    },
  }
}
