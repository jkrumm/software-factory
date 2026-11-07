import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { RepoRefused, resolveSpaceDir } from './repos.ts'

/** How often the fixed spaces are looked at again (the first look is the first tick). */
export const SPACES_INTERVAL_MS = 10 * 60_000

/** `~/.config/factory/spaces.json`, written by dotfiles `make setup`: the repos that get a space and a planner shell, in the owner's order. */
const SpacesFile = z.object({
  spaces: z.array(
    z.object({
      name: z.string().regex(/^[A-Za-z0-9._-]+$/),
      path: z.string().refine(isAbsolute, 'an absolute path'),
    }),
  ),
})

/** The part of the Runner the reconcile needs: a planner shell for a repo, started if it is not there. */
export interface PlanRunner {
  ensurePlan(input: { name: string; repo: string }): Promise<'present' | 'started'>
}

export interface SpacesDeps {
  /** `FACTORY_SPACES_FILE` */
  file: string
  /** `FACTORY_REPO_ROOTS`: an entry outside them is not ours to place a shell into */
  roots: readonly string[]
  runner: PlanRunner
  now: () => Date
  intervalMs?: number
}

export interface SpacesResult {
  started: string[]
  present: string[]
  skipped: { name: string; reason: string }[]
  errors: string[]
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The fixed spaces: every repo in the owner's list has a space and a `plan:<name>` tab, a login shell the owner starts the planner in.
 * The reconcile only adds: a space the app lacks is seeded, a plan terminal that is not live is started (`HcRunner.ensurePlan`,
 * through the runner's own lock); it never reorders the app's document, never moves a tab, and never closes a plan tab
 * (`HcRunner.close` refuses a `plan:` key). A listed root (IuRoot) gets a plan tab too; it is no project: no project.yaml, no git, no
 * spawn. A space the app left unnamed gets the entry's name. The order of the sidebar is the app's (dotfiles' `groups.json`).
 *
 * It runs behind the tick's back (`kick`), never in a transaction, once at start and then every ten minutes; every effect has a
 * deterministic key, so a second pass with nothing changed starts nothing and writes nothing.
 */
export class Spaces {
  private lastStart = 0
  private running: Promise<unknown> | undefined
  /** the last problem with the file that was logged: the same one is logged once, not every ten minutes */
  private noted = ''

  constructor(private readonly deps: SpacesDeps) {}

  /** The tick's call. Never throws and never waits for the pass; one pass at a time. */
  kick(): void {
    const now = this.deps.now().getTime()
    if (this.running || now - this.lastStart < (this.deps.intervalMs ?? SPACES_INTERVAL_MS)) return
    this.lastStart = now
    this.running = this.reconcile()
      .then((result) => {
        if (result.started.length || result.errors.length) console.log('spaces', JSON.stringify(result))
      })
      .catch((error: unknown) => console.error('spaces failed', message(error)))
      .finally(() => {
        this.running = undefined
      })
  }

  /** Waits for the pass in flight: shutdown and the tests. */
  async settled(): Promise<void> {
    await this.running
  }

  /** One pass over the list, in file order. An absent or invalid file does nothing. */
  async reconcile(): Promise<SpacesResult> {
    const result: SpacesResult = { started: [], present: [], skipped: [], errors: [] }
    const entries = await this.entries()
    const seen = new Set<string>()
    for (const entry of entries) {
      if (seen.has(entry.name)) {
        result.skipped.push({ name: entry.name, reason: 'listed twice' })
        continue
      }
      seen.add(entry.name)
      let repo: string
      try {
        repo = await resolveSpaceDir(entry.path, this.deps.roots)
      } catch (error) {
        if (!(error instanceof RepoRefused)) throw error
        result.skipped.push({ name: entry.name, reason: error.message })
        continue
      }
      try {
        const outcome = await this.deps.runner.ensurePlan({ name: entry.name, repo })
        result[outcome === 'started' ? 'started' : 'present'].push(entry.name)
      } catch (error) {
        // One repo's failure holds nothing back; the next pass looks again.
        result.errors.push(`${entry.name}: ${message(error)}`)
      }
    }
    return result
  }

  private async entries(): Promise<z.output<typeof SpacesFile>['spaces']> {
    let text: string
    try {
      text = await readFile(this.deps.file, 'utf8')
    } catch (error) {
      this.note(`no spaces file at ${this.deps.file} (${message(error)}); no space is placed`)
      return []
    }
    let parsed: z.ZodSafeParseResult<z.output<typeof SpacesFile>>
    try {
      parsed = SpacesFile.safeParse(JSON.parse(text))
    } catch (error) {
      this.note(`${this.deps.file} is not JSON (${message(error)}); no space is placed`)
      return []
    }
    if (!parsed.success) {
      this.note(
        `${this.deps.file} is not a spaces list (${parsed.error.issues[0]?.message ?? 'invalid'}); no space is placed`,
      )
      return []
    }
    this.noted = ''
    return parsed.data.spaces
  }

  private note(text: string): void {
    if (text === this.noted) return
    this.noted = text
    console.warn('spaces:', text)
  }
}
