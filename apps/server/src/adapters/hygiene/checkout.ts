import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Checkout } from '../../domains/loops/hygiene-model.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { CannotExecute } from '../hc/process.ts'
import { gitOut, gitTry, ProcessFailed, type Tools } from './git.ts'

const FETCH_TIMEOUT_MS = 90_000

/** `Repos` of `domains/leads/ports.ts`, as far as this adapter needs it (an adapter reaches one domain only). */
export interface RepoLocator {
  locate(repo: string): Promise<Result<string>>
}

/** Origin's default branch, as the lead's worktrees find it. */
async function originDefault(tools: Tools, repo: string): Promise<string | undefined> {
  const head = await gitTry(tools, repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  if (head?.trim()) return head.trim()
  for (const candidate of ['origin/master', 'origin/main']) {
    if (await gitTry(tools, repo, ['rev-parse', '-q', '--verify', candidate])) return candidate
  }
  return undefined
}

async function resolve(tools: Tools, repo: string, ref: string | null): Promise<string> {
  const target = ref ?? (await originDefault(tools, repo))
  if (!target) throw new ProcessFailed(`no origin default branch in ${repo}`, 'refused')
  const sha = (await gitOut(tools, repo, ['rev-parse', '--verify', '-q', `${target}^{commit}`])).trim()
  if (!sha) throw new ProcessFailed(`${target} does not resolve in ${repo}`)
  return sha
}

async function discard(tools: Tools, repo: string, path: string): Promise<void> {
  await gitTry(tools, repo, ['worktree', 'remove', '--force', path])
  await gitTry(tools, repo, ['worktree', 'prune'])
  await rm(path, { recursive: true, force: true }).catch(() => {})
}

/**
 * A detached throwaway worktree of `repo` at `ref` (origin's default branch when null), after a fetch, handed to `use`
 * and removed on every path, including when `use` throws (that is a `gone`).
 */
export async function withCheckout<T>(
  tools: Tools,
  repos: RepoLocator,
  repo: string,
  ref: string | null,
  use: (checkout: Checkout) => Promise<T>,
): Promise<Result<T, PortError>> {
  const located = await repos.locate(repo)
  if (!located.ok) return located
  const dir = located.value
  let path: string | undefined
  try {
    await gitOut(tools, dir, ['fetch', '-q', 'origin'], FETCH_TIMEOUT_MS)
    const sha = await resolve(tools, dir, ref)
    const parent = join(tmpdir(), 'factory-hygiene')
    await mkdir(parent, { recursive: true })
    path = await mkdtemp(join(parent, `${repo.replace(/[^A-Za-z0-9._-]+/g, '-')}-${sha.slice(0, 7)}-`))
    await gitOut(tools, dir, ['worktree', 'add', '-q', '--detach', path, sha])
    return ok(await use({ path, ref: sha }))
  } catch (error) {
    if (error instanceof ProcessFailed) return err(portError(error.kind, error.message))
    if (error instanceof CannotExecute) return err(portError('gone', error.message))
    return err(portError('gone', `the hygiene pass failed in ${repo}: ${String(error)}`))
  } finally {
    if (path) await discard(tools, dir, path)
  }
}
