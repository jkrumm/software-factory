import type { HygieneCandidate } from '@software-factory/contract'
import { gitOut, type Tools } from './git.ts'

const DAY_MS = 86_400_000
const STALE_DAYS = 14
const STALE_COMMITS = 20
const STALE_TOP = 12
const SLOP_DAYS = 30
const SLOP_LINES = 15
const SLOP_TOP = 10
const CONCURRENCY = 6

interface DocHistory {
  lastSha: string
  lastAt: Date
  /** lines added and removed within the slop window */
  recentLines: number
}

/** One `git log` over the markdown: the last edit of each living document and the lines edited lately. */
async function histories(tools: Tools, path: string, docs: Set<string>, now: Date): Promise<Map<string, DocHistory>> {
  const out = await gitOut(tools, path, ['log', '--format=%x00%H%x09%cI', '--numstat', '--', '*.md'], 120_000)
  const history = new Map<string, DocHistory>()
  for (const block of out.split('\0').slice(1)) {
    const [head = '', ...rows] = block.split('\n')
    const [sha = '', iso = ''] = head.split('\t')
    const at = new Date(iso)
    if (!sha || Number.isNaN(at.getTime())) continue
    const recent = now.getTime() - at.getTime() <= SLOP_DAYS * DAY_MS
    for (const row of rows) {
      const [added = '', removed = '', file = ''] = row.split('\t')
      if (!docs.has(file)) continue
      const lines = recent ? (Number.parseInt(added, 10) || 0) + (Number.parseInt(removed, 10) || 0) : 0
      const known = history.get(file)
      // newest commit first: the first sight is the last edit
      if (known) known.recentLines += lines
      else history.set(file, { lastSha: sha, lastAt: at, recentLines: lines })
    }
  }
  return history
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(work))))
  }
  return results
}

const day = (date: Date): string => date.toISOString().slice(0, 10)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Documents to read, picked without a model: `stale` have not been edited for two weeks while 20 or more commits
 * changed the code, `slop` were edited a lot lately.
 */
export async function candidates(
  tools: Tools,
  path: string,
  docs: string[],
  now = new Date(),
): Promise<{ stale: HygieneCandidate[]; slop: HygieneCandidate[] }> {
  const history = await histories(tools, path, new Set(docs), now)
  const aged = [...history].filter(([, h]) => now.getTime() - h.lastAt.getTime() >= STALE_DAYS * DAY_MS)
  const counted = await inBatches(aged, CONCURRENCY, async ([file, h]) => {
    const count = await gitOut(tools, path, [
      'rev-list',
      '--count',
      `${h.lastSha}..HEAD`,
      '--',
      '.',
      ':(exclude)*.md',
      ':(exclude)docs',
    ]).catch(() => '0')
    return { file, h, since: Number.parseInt(count, 10) || 0 }
  })
  const stale = counted
    .filter((c) => c.since >= STALE_COMMITS)
    .sort((a, b) => b.since - a.since || a.file.localeCompare(b.file))
    .slice(0, STALE_TOP)
    .map((c) => ({ path: c.file, why: `last edited ${day(c.h.lastAt)}; ${c.since} commits to code since` }))
  const slop = [...history]
    .filter(([, h]) => h.recentLines >= SLOP_LINES)
    .sort(([a, x], [b, y]) => y.lastAt.getTime() - x.lastAt.getTime() || a.localeCompare(b))
    .slice(0, SLOP_TOP)
    .map(([file, h]) => ({
      path: file,
      why: `edited ${plural(Math.floor((now.getTime() - h.lastAt.getTime()) / DAY_MS), 'day')} ago; ${h.recentLines} lines`,
    }))
  return { stale, slop }
}
