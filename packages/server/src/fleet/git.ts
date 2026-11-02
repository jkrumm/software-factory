import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { FleetGit } from '@software-factory/contract'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { GIT_TIMEOUT_MS } from './sources.ts'

/** Bounded, read-only git for the fleet builder: every call has a timeout, none writes (`--no-optional-locks`), none runs in a transaction. */
export class GitReader {
  constructor(private readonly run: typeof runProcess = runProcess) {}

  private async git(cwd: string, args: string[]): Promise<string> {
    const done = await this.run(
      ['git', '--no-optional-locks', '-C', cwd, ...args],
      GIT_TIMEOUT_MS,
      childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    )
    if (done.exitCode === EXIT_TIMEOUT) throw new Error(`git ${args[0]} did not answer in time`)
    if (done.exitCode !== 0) throw new Error(`git ${args[0]} failed (exit ${done.exitCode})`)
    return done.stdout
  }

  /** Branch, the dirty bit (untracked files do not count) and the last commit. An empty repo has no commit; a detached head no branch. */
  async state(repo: string): Promise<FleetGit> {
    const status = await this.git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'])
    let branch: string | null = null
    let dirty = false
    for (const line of status.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim()
        branch = head === '(detached)' ? null : head
      } else if (line && !line.startsWith('#')) dirty = true
    }
    const log = await this.git(repo, ['log', '-1', '--format=%H%x1f%cI%x1f%s']).catch(() => '')
    const [sha, at, subject] = log.trim().split('\x1f')
    return { branch, dirty, lastCommit: sha && at ? { sha: sha.slice(0, 12), at, subject: subject ?? '' } : null }
  }

  /** The time of the file's last commit; the file's mtime for one that has none (untracked, or outside any repo). */
  async touched(file: string): Promise<string | null> {
    const committed = await this.git(dirname(file), ['log', '-1', '--format=%cI', '--', basename(file)]).catch(() => '')
    if (committed.trim()) return committed.trim()
    return stat(file).then(
      (s) => s.mtime.toISOString(),
      () => null,
    )
  }
}
