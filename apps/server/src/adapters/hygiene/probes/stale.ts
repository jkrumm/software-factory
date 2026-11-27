import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { leadBranchIssue } from '../../../kernel/ids.ts'
import { originDefault } from '../checkout.ts'
import { exec, gitOut, gitTry, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'

const STALE_DAYS = 30
const DAY_S = 86_400
/** A merged worktree or default-tip branch is a leftover only after this long without activity: a lead's fresh one is not. */
const QUIET_S = 2 * DAY_S
const GH_TIMEOUT_MS = 30_000
/** The newest merged pull requests read for their head branches. */
const MERGED_PRS = '1000'

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

/**
 * A lead's own worktree (`factory/<issue>-<attempt>`, or its `factory-<issue>-<attempt>` directory once its branch is gone):
 * the lead's finalization removes it when the work landed, and a lead that waits days for a Decision or a date is idle in it,
 * not done with it. The scan leaves them out, so the probe never flags one and the fix never removes one.
 */
const isLeadWorktree = (w: Worktree): boolean =>
  leadBranchIssue(w.branch ?? '') !== null ||
  /^factory-[1-9][0-9]*-[1-9][0-9]*$/.test(w.path.split(/[\\/]/).filter(Boolean).at(-1) ?? '')

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

/**
 * `${branch} ${sha}` for each branch whose pull request merged at that head. A squash or rebase merge leaves no merge in
 * git's history, so `git branch --merged` cannot see it; the pull request records the head it merged at, and a branch still
 * there is merged. Empty when gh cannot read the repo: the probe then keeps to git's answer.
 */
async function mergedPullRequestHeads(tools: Tools, path: string): Promise<Set<string>> {
  const result = await exec(
    [
      tools.gh,
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      MERGED_PRS,
      '--json',
      'headRefName,headRefOid,isCrossRepository',
    ],
    GH_TIMEOUT_MS,
    path,
  ).catch(() => undefined)
  const stdout = result?.exitCode === 0 ? result.stdout : undefined
  if (stdout === undefined) return new Set()
  try {
    const rows: unknown = JSON.parse(stdout)
    if (!Array.isArray(rows)) return new Set()
    return new Set(
      rows.flatMap((row: { headRefName?: unknown; headRefOid?: unknown; isCrossRepository?: unknown }) =>
        typeof row.headRefName === 'string' && typeof row.headRefOid === 'string' && row.isCrossRepository !== true
          ? [`${row.headRefName} ${row.headRefOid}`]
          : [],
      ),
    )
  } catch {
    return new Set()
  }
}

const reason = (merged: boolean, days: number): string | undefined =>
  merged ? 'merged' : days > STALE_DAYS ? `untouched ${days} days` : undefined

/** One remote branch the scan flags, and why. */
export interface StaleBranch {
  name: string
  why: string
  ts: number
}
export interface StaleWorktree {
  worktree: Worktree
  why: string
}

/** What the probe saw: the flagged remote branches (merged ones first), the flagged linked worktrees, and the totals. */
export interface StaleScan {
  /** the default branch's short name (`master`) */
  defaultName: string
  remoteCount: number
  linkedCount: number
  branches: StaleBranch[]
  worktrees: StaleWorktree[]
}

/** Reads the repo: a string (its reason) when there is nothing to scan. The probe and its scripted fix share it, so the fix deletes exactly what the probe flags. */
export async function scanStale(tools: Tools, path: string): Promise<StaleScan | string> {
  const target = await originDefault(tools, path)
  if (!target) return 'no origin default branch'
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
    (w) => realOrSelf(w.path) !== here && !w.path.split(/[\\/]/).includes('hygiene') && !isLeadWorktree(w),
  )
  if (!remote.length && !linked.length) return 'no remote branches and no linked worktrees'

  const defaultTip = (await gitTry(tools, path, ['rev-parse', '--verify', '-q', target]))?.trim()
  const squashed = remote.length ? await mergedPullRequestHeads(tools, path) : new Set<string>()
  const branches = remote
    .map((b) => ({
      name: b.name,
      ts: b.ts,
      why: reason(
        (mergedRemote.has(b.name) || squashed.has(`${b.name} ${b.tip}`)) &&
          (b.tip !== defaultTip || now - b.ts >= QUIET_S),
        Math.floor((now - b.ts) / DAY_S),
      ),
    }))
    .flatMap((b) => (b.why ? [{ ...b, why: b.why }] : []))
    .sort((a, b) => Number(b.why === 'merged') - Number(a.why === 'merged') || a.ts - b.ts)

  const worktrees: StaleWorktree[] = []
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
    if (why) worktrees.push({ worktree: w, why })
  }
  return { defaultName, remoteCount: remote.length, linkedCount: linked.length, branches, worktrees }
}

/** Remote branches merged into the default branch or untouched for 30 days, and leftover worktrees (prunable, merged or untouched). */
export async function staleProbe(tools: Tools, path: string): Promise<Outcome> {
  const scan = await scanStale(tools, path)
  if (typeof scan === 'string') return skipped(scan)
  const branchLines = scan.branches.map((b) => `origin/${b.name} (${b.why})`)
  const worktreeLines = scan.worktrees.map(
    ({ worktree: w, why }) => `${shortPath(w.path)}${w.branch ? ` [${w.branch}]` : ''} (${why})`,
  )
  const findings = []
  if (branchLines.length) {
    findings.push(finding('stale', 'stale:branches', 'Hygiene: stale remote branches', branchLines, branchLines.length))
  }
  if (worktreeLines.length) {
    findings.push(
      finding('stale', 'stale:worktrees', 'Hygiene: leftover worktrees', worktreeLines, worktreeLines.length),
    )
  }
  const detail = `${scan.remoteCount} remote branches, ${scan.linkedCount} worktrees against ${scan.defaultName}`
  return findings.length ? found(detail, findings) : clean(detail)
}
