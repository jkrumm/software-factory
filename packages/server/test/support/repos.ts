import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A directory of git repos for the tests of projects: one root, repos made by `repo()`. */
export function repoRoot(prefix = 'factory-projects-') {
  const root = realpathSync(mkdtempSync(`/tmp/${prefix}`))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(
      ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd, env, stderr: 'pipe', stdout: 'pipe' },
    )
    if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
    return run.stdout.toString().trim()
  }
  return {
    root,
    git,
    /** A repo on `master` with these files committed. */
    repo(name: string, files: Record<string, string> = {}, at: string = root): string {
      const path = join(at, name)
      mkdirSync(path, { recursive: true })
      git(path, 'init', '-q', '-b', 'master')
      write(path, files)
      git(path, 'add', '-A')
      git(path, 'commit', '-q', '--allow-empty', '-m', 'init')
      return path
    },
    /** Commits these files on the branch that is checked out. */
    commit(path: string, files: Record<string, string>): void {
      write(path, files)
      git(path, 'add', '-A')
      git(path, 'commit', '-q', '-m', 'change')
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function write(path: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), text)
  }
}
