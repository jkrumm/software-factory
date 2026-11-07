import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A git repo with a bare origin, both in a temp dir: what a ship's commits are checked against. */
export interface GitRepo {
  /** the clone: the Issue's repo */
  path: string
  /** the bare origin */
  origin: string
  git(...args: string[]): Promise<string>
  /** writes a file, commits it and pushes `master`; returns the commit */
  commit(file: string, text: string, message?: string): Promise<string>
  /** another clone of the origin, to merge work the way a pull request does */
  other(): Promise<{ path: string; commit(file: string, text: string, message?: string): Promise<string> }>
  stop(): Promise<void>
}

async function run(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}: ${err}`)
  return out.trim()
}

async function committer(path: string) {
  return async (file: string, text: string, message = `change ${file}`): Promise<string> => {
    await mkdir(dirname(join(path, file)), { recursive: true })
    await writeFile(join(path, file), text)
    await run(path, ['add', '-A'])
    await run(path, ['commit', '-q', '-m', message])
    await run(path, ['push', '-q', 'origin', 'master'])
    return run(path, ['rev-parse', 'HEAD'])
  }
}

/** `Makefile` is committed first, so `make verify`, `make version` and `make deploy` exist in the clone. */
export async function startGitRepo(makefile?: string): Promise<GitRepo> {
  const root = await mkdtemp('/tmp/factory-repo-')
  const origin = join(root, 'origin.git')
  const path = join(root, 'clone')
  await run(root, ['init', '-q', '--bare', '-b', 'master', origin])
  await run(root, ['clone', '-q', origin, path])
  await run(path, ['symbolic-ref', 'HEAD', 'refs/heads/master'])
  const commit = await committer(path)
  if (makefile !== undefined) await commit('Makefile', makefile, 'chore: makefile')
  else await commit('README.txt', 'start\n', 'chore: start')
  await run(path, ['remote', 'set-head', 'origin', 'master'])
  return {
    path,
    origin,
    git: (...args) => run(path, args),
    commit,
    other: async () => {
      const clone = join(root, `other-${Math.random().toString(36).slice(2)}`)
      await run(root, ['clone', '-q', origin, clone])
      return { path: clone, commit: await committer(clone) }
    },
    stop: () => rm(root, { recursive: true, force: true }),
  }
}
