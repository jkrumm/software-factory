#!/usr/bin/env bun
/**
 * One-time clean-up of the lead branches `finalizeLead` left behind (`factory/<issue>-<attempt>`, local and on origin).
 * The rule is the adapter's own (`apps/server/src/adapters/git/branches.ts`): a closed Issue's branch goes when it was
 * dropped or cancelled, or its work is on origin's default (ancestry, an empty merge, a shipped commit, a merged pull
 * request). The Issue behind each number is read with `factory issue show`; an open or unknown Issue keeps its branches.
 *
 *   bun scripts/prune-lead-branches.ts [--repo <main checkout>] [--apply]
 *
 * Without --apply nothing is deleted: the table says what would be. Needs the `factory` CLI; the merged-pull-request
 * rule uses FACTORY_GITHUB_TOKEN, else `gh auth token`, else is skipped.
 */
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gitBranches } from '../apps/server/src/adapters/git/branches.ts'
import { runProcess, type Run } from '../apps/server/src/adapters/quality/process.ts'
import type { BranchClosure } from '../apps/server/src/domains/leads/ports.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const repoArg = args.indexOf('--repo') >= 0 ? args[args.indexOf('--repo') + 1] : undefined

async function out(cmd: string[], cwd?: string): Promise<string | undefined> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', ...(cwd ? { cwd } : {}) })
  const text = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? text.trim() : undefined
}

async function mainCheckout(): Promise<string> {
  if (repoArg) return resolve(repoArg)
  const common = await out(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) throw new Error('not in a git repository: pass --repo')
  return realpathSync(dirname(common))
}

async function githubToken(): Promise<string | null> {
  return process.env.FACTORY_GITHUB_TOKEN || (await out(['gh', 'auth', 'token'])) || null
}

interface IssueFacts {
  state: string
  outcome: string | null
  shipped: string[]
}

async function issueFacts(number: number): Promise<IssueFacts | undefined> {
  const text = await out(['factory', 'issue', 'show', `issue_${number}`, '--format', 'json'])
  if (!text) return undefined
  try {
    const issue = JSON.parse(text) as {
      state?: string
      outcome?: string | null
      shipping?: { result?: string; commits?: string[] }[]
    }
    if (typeof issue.state !== 'string') return undefined
    const shipped = (issue.shipping ?? []).flatMap((ship) => (ship.result === 'accepted' ? (ship.commits ?? []) : []))
    return { state: issue.state, outcome: issue.outcome ?? null, shipped: [...new Set(shipped)] }
  } catch {
    return undefined
  }
}

/** Dry run: git deletes nothing, and says it did. */
const dryRun: Run = (cmd, timeoutMs, options) => {
  const deletes = cmd.includes('push') || (cmd.includes('branch') && cmd.includes('-D'))
  return deletes ? Promise.resolve({ exitCode: 0, stdout: '' }) : runProcess(cmd, timeoutMs, options)
}

const repo = await mainCheckout()
const refs = await out([
  'git',
  '-C',
  repo,
  'for-each-ref',
  '--format=%(refname)',
  'refs/heads/factory/',
  'refs/remotes/origin/factory/',
])
if (refs === undefined) throw new Error(`cannot list the branches of ${repo}`)
const numbers = [...new Set(refs.split('\n').flatMap((ref) => /\/factory\/(\d+)-\d+$/.exec(ref)?.[1] ?? []))]
  .map(Number)
  .sort((a, b) => a - b)

const branches = gitBranches({
  token: await githubToken(),
  apiUrl: process.env.FACTORY_GITHUB_API_URL ?? 'https://api.github.com',
  ...(apply ? {} : { run: dryRun }),
})

const rows: { branch: string; action: 'delete' | 'keep'; why: string }[] = []
for (const number of numbers) {
  const facts = await issueFacts(number)
  const names = [
    ...new Set(refs.split('\n').flatMap((ref) => new RegExp(`/(factory/${number}-\\d+)$`).exec(ref)?.[1] ?? [])),
  ]
  if (facts?.state !== 'closed') {
    const why = facts ? 'Issue open' : 'Issue unknown'
    for (const branch of names) rows.push({ branch, action: 'keep', why })
    continue
  }
  const closed: BranchClosure = facts.outcome === 'dropped' || facts.outcome === 'cancelled' ? facts.outcome : 'other'
  const cleaned = await branches.clean({ repo, issue: number, closed, shipped: facts.shipped })
  for (const branch of names) {
    const kept = cleaned.ok ? cleaned.value.kept.find((k) => k.branch === branch) : undefined
    if (!cleaned.ok) rows.push({ branch, action: 'keep', why: cleaned.error.detail })
    else if (kept) rows.push({ branch, action: 'keep', why: kept.why })
    else rows.push({ branch, action: 'delete', why: `Issue ${facts.outcome ?? 'closed'}` })
  }
}

const width = Math.max(6, ...rows.map((row) => row.branch.length))
console.log(`${apply ? 'APPLIED' : 'DRY RUN'} in ${repo}`)
for (const row of rows) console.log(`${row.branch.padEnd(width)}  ${row.action.padEnd(6)}  ${row.why}`)
const count = (action: string) => rows.filter((row) => row.action === action).length
console.log(`\n${count('delete')} ${apply ? 'deleted' : 'to delete'}, ${count('keep')} kept`)
