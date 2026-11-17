import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { originDefault } from '../checkout.ts'
import { gitOut, gitTry, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'

const STALE_DAYS = 30
const DAY_S = 86_400
/** A merged worktree or default-tip branch is a leftover only after this long without activity: a lead's fresh one is not. */
const QUIET_S = 2 * DAY_S

export interface Worktree {
  path: string
  head: string
  branch?: string
  prunable: boolean
}

/** The linked worktrees of `git worktree list --porcelain`: the main checkout (the first block) and bare ones are dropped. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const blocks = porcelain.split(/\n\n+/).filter((b) => b.trim())
  return blocks.slice(1).flatMap((block) => {
    const lines = block.split('\n')
    const field = (name: string) => lines.find((l) => l === name || l.startsWith(`${name} `))?.slice(name.length + 1)
    const path = field('worktree')
    if (!path || lines.includes('bare')) return []
    return [
      {
        path,
        head: field('HEAD') ?? '',
        branch: field('branch')?.replace(/^refs\/heads\//, ''),
        prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
      },
    ]
  })
}

/** The last two path segments, never an absolute path. */
export const shortPath = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Seconds since the worktree's own `index` or `HEAD` was last written; undefined when neither can be read. */
async function idleSeconds(tools: Tools, worktree: string, now: number): Promise<number | undefined> {
  const gitDir = (await gitTry(tools, worktree, ['rev-parse', '--absolute-git-dir']))?.trim()
  if (!gitDir) return undefined
  const times = ['index', 'HEAD'].flatMap((name) => {
    try {
      return [Math.floor(statSync(join(gitDir, name)).mtimeMs / 1000)]
    } catch {
      return []
    }
  })
  return times.length ? now - Math.max(...times) : undefined
}

const reason = (merged: boolean, days: number): string | undefined =>
  merged ? 'merged' : days > STALE_DAYS ? `untouched ${days} days` : undefined

/** Remote branches merged into the default branch or untouched for 30 days, and leftover worktrees (prunable, merged or untouched). */
export async function staleProbe(tools: Tools, path: string): Promise<Outcome> {
  const target = await originDefault(tools, path)
  if (!target) return skipped('no origin default branch')
  const now = Math.floor(Date.now() / 1000)
  const defaultName = target.replace(/^origin\//, '')

  const refs = await gitOut(tools, path, [
    'for-each-ref',
    '--format=%(refname:short) %(committerdate:unix) %(objectname)',
    'refs/remotes/origin',
  ])
  const remote = refs
    .split('\n')
    .map((l) => l.trim().split(' '))
    .flatMap(([name, ts, tip]) =>
      name?.startsWith('origin/') && name !== 'origin/HEAD' && name !== target && ts
        ? [{ name: name.slice(7), ts: Number(ts), tip }]
        : [],
    )
  const mergedRemote = new Set(
    (await gitOut(tools, path, ['branch', '-r', '--merged', target]))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.includes('->'))
      .map((l) => l.replace(/^origin\//, '')),
  )

  const here = realOrSelf(path)
  const linked = parseWorktrees(await gitOut(tools, path, ['worktree', 'list', '--porcelain'])).filter(
    (w) => realOrSelf(w.path) !== here && !w.path.split(/[\\/]/).includes('hygiene'),
  )
  if (!remote.length && !linked.length) return skipped('no remote branches and no linked worktrees')

  const defaultTip = (await gitTry(tools, path, ['rev-parse', '--verify', '-q', target]))?.trim()
  const branchLines = remote
    .map((b) => ({
      ...b,
      days: Math.floor((now - b.ts) / DAY_S),
      why: reason(
        mergedRemote.has(b.name) && (b.tip !== defaultTip || now - b.ts >= QUIET_S),
        Math.floor((now - b.ts) / DAY_S),
      ),
    }))
    .filter((b) => b.why)
    .sort((a, b) => Number(b.why === 'merged') - Number(a.why === 'merged') || a.ts - b.ts)
    .map((b) => `origin/${b.name} (${b.why})`)

  const worktreeLines: string[] = []
  for (const w of linked) {
    const committed = Number(
      (await gitTry(tools, w.path, ['log', '-1', '--format=%ct', w.head || 'HEAD']))?.trim() || now,
    )
    const idle = await idleSeconds(tools, w.path, now)
    // Activity is the newer of the last commit and the last write to the worktree's own index or HEAD.
    const days = Math.floor(Math.min(now - committed, idle ?? Infinity) / DAY_S)
    const ancestor =
      w.head &&
      w.head !== defaultTip &&
      (await gitTry(tools, path, ['merge-base', '--is-ancestor', w.head, target])) !== undefined
    const why = w.prunable ? 'prunable' : reason(Boolean(ancestor) && idle !== undefined && idle >= QUIET_S, days)
    if (why) worktreeLines.push(`${shortPath(w.path)}${w.branch ? ` [${w.branch}]` : ''} (${why})`)
  }

  const findings = []
  if (branchLines.length) {
    findings.push(finding('stale', 'stale:branches', 'Hygiene: stale remote branches', branchLines, branchLines.length))
  }
  if (worktreeLines.length) {
    findings.push(
      finding('stale', 'stale:worktrees', 'Hygiene: leftover worktrees', worktreeLines, worktreeLines.length),
    )
  }
  const detail = `${remote.length} remote branches, ${linked.length} worktrees against ${defaultName}`
  return findings.length ? found(detail, findings) : clean(detail)
}
