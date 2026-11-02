import { basename } from 'node:path'
import {
  DEFAULT_HOLD,
  defaultManifest,
  durationMs,
  EVIDENCE_KINDS,
  type EvidenceKind,
  type ProjectManifest,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { projectOfPath } from '../projects/claims.ts'
import { getProject } from '../projects/store.ts'
import { type Commits, CommitsRefused } from './commits.ts'
import { leadBranch } from './names.ts'
import type { Context } from './shared.ts'

/** §5's table, what each kind asks for: the words the lead reads when it is missing. */
export const EVIDENCE_MEANS: Record<EvidenceKind, string> = {
  ui: 'a production screenshot of the changed screen',
  service: '`make verify`, error rate and p95 of the changed endpoints, before and after',
  infra: "the service's status and logs after the change",
  data: 'the queries that show the data is right',
}

// The manifest names only `deploy.migrations`. The rest is how repos here are laid out, and a path none of these names is a service.
const glob = (patterns: readonly string[]) => patterns.map((pattern) => new Bun.Glob(pattern))

const INERT = glob([
  'docs/**',
  '**/*.md',
  '**/*.mdx',
  '**/*.txt',
  '**/LICENSE*',
  '.gitignore',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
])
const INFRA = glob([
  'deploy/**',
  'infra/**',
  'ops/**',
  'scripts/**',
  'config/**',
  'k8s/**',
  'helm/**',
  '.github/**',
  '**/Makefile',
  '**/Dockerfile*',
  '**/docker-compose*',
  '**/compose.y*ml',
  '**/*.tf',
  '**/*.plist*',
  '**/.env*',
  'project.yaml',
])
const UI = glob([
  '**/*.tsx',
  '**/*.jsx',
  '**/*.vue',
  '**/*.svelte',
  '**/*.astro',
  '**/*.css',
  '**/*.scss',
  '**/*.html',
  '**/public/**',
  '**/assets/**',
])

const matches = (patterns: readonly Bun.Glob[], path: string) => patterns.some((pattern) => pattern.match(path))

/** A manifest's path: a directory (`migrations/`), a file, or a glob. */
const under = (pattern: string, path: string): boolean => {
  const bare = pattern.replace(/\/+$/, '')
  return path === bare || path.startsWith(`${bare}/`) || new Bun.Glob(pattern).match(path)
}

/** What one path asks for; `null` is a path nothing deploys. A migration is `data` first, whatever else it looks like. */
export function kindOfPath(path: string, manifest: ProjectManifest): EvidenceKind | null {
  if (manifest.deploy.migrations.some((pattern) => under(pattern, path))) return 'data'
  if (matches(INERT, path)) return null
  if (matches(INFRA, path)) return 'infra'
  if (matches(UI, path)) return 'ui'
  return 'service'
}

/** The evidence these paths require: none where nothing deploys, so a project with no manifest closes with the commit or the document. */
export function requiredEvidence(paths: readonly string[], manifest: ProjectManifest): EvidenceKind[] {
  if (manifest.deploy.mode === 'none') return []
  const kinds = new Set(paths.map((path) => kindOfPath(path, manifest)))
  return EVIDENCE_KINDS.filter((kind) => kinds.has(kind))
}

/** The answer of `derive`, carried on the verb's inbox row: the lifecycle decides inside a transaction, where no git can run. */
export interface Derived {
  commits: string[]
  /** a sample for the answer and the record, as `commits` is; `required` was worked out from all of them */
  paths: string[]
  required: EvidenceKind[]
  mergedAt: string | null
  holdMs: number
  /** why the commits cannot count */
  problem: string | null
}

const MAX_RECORDED = 100

/**
 * What the verb's commits require, from git and the project's manifest. Outside any transaction: the lead's call waits for it, the tick
 * does not. Set by the server on the row, never from the body, so a lead cannot pick a lighter bar. A git that fails refuses the verb.
 */
export async function derive(
  sql: SQL,
  commits: Commits,
  input: { issueId: number; repo: string; attempt: number; reported: readonly string[]; merged: boolean },
): Promise<Derived> {
  const { issueId, repo, attempt, reported, merged } = input
  const owner = await projectOfPath(sql, repo)
  const project = owner ? await getProject(sql, owner.name) : undefined
  const manifest = project?.manifest ?? defaultManifest(basename(repo))
  const holdMs = durationMs(manifest.deploy.hold) ?? durationMs(DEFAULT_HOLD) ?? 0
  const [tree]: { sha: string | null }[] = await sql`
    SELECT sha FROM factory.lead_worktrees WHERE issue_id = ${issueId} AND attempt = ${attempt}`
  const none = { commits: [], paths: [], required: [], mergedAt: null, holdMs, problem: null }
  if (reported.length === 0 && !tree?.sha) return none
  try {
    const read = await commits.read({
      repo,
      branch: leadBranch(issueId, attempt),
      cut: tree?.sha ?? null,
      reported,
      merged,
    })
    return {
      commits: read.commits.slice(0, MAX_RECORDED),
      paths: read.paths.slice(0, MAX_RECORDED),
      required: requiredEvidence(read.paths, manifest),
      mergedAt: read.mergedAt?.toISOString() ?? null,
      holdMs,
      problem: null,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...none, problem: error instanceof CommitsRefused ? reason : `the commits could not be read: ${reason}` }
  }
}

const derivedOf = (row: Context['row']): Derived | undefined => row.payload?.derived as Derived | undefined

/** What a verb carries from `derive`; a row without it was not filed by a lead's call. */
export const holdMsOf = (row: Context['row']): number | undefined => derivedOf(row)?.holdMs

/** One row of `evidence`; a repeated key is the first one's. */
export async function storeEvidence(
  tx: SQL,
  input: {
    issueId: number
    key: string
    attempt: number
    kind: string
    link?: string | null
    payload?: Record<string, unknown> | null
    at: Date
    author: string
  },
): Promise<{ duplicate: boolean }> {
  const rows = await tx`
    INSERT INTO factory.evidence (issue_id, key, attempt, kind, link, payload, at, author)
    VALUES (${input.issueId}, ${input.key}, ${input.attempt}, ${input.kind}, ${input.link ?? null}, ${input.payload ?? null}, ${input.at}, ${input.author})
    ON CONFLICT (key) DO NOTHING
    RETURNING id`
  return { duplicate: rows.length === 0 }
}

/**
 * The kinds required and not met, each with what it asks for. Existence and freshness only: what the evidence says is never read. Only
 * this attempt's counts: a reopened Issue proves itself again, whatever commit it names.
 */
async function missingEvidence({ tx, issue }: Context, derived: Derived): Promise<string[]> {
  if (derived.required.length === 0) return []
  const stored: { kind: EvidenceKind; newest: Date }[] = await tx`
    SELECT kind, max(at) AS newest FROM factory.evidence
    WHERE issue_id = ${issue.id} AND attempt = ${issue.attempt} AND kind IN ${tx([...derived.required])} GROUP BY kind`
  const since = derived.mergedAt ? new Date(derived.mergedAt).getTime() : 0
  return derived.required.flatMap((kind) => {
    const found = stored.find((row) => row.kind === kind)
    if (!found) return [`${kind} (${EVIDENCE_MEANS[kind]})`]
    // Commit times have whole seconds, so a report in the commit's own second counts.
    if (found.newest.getTime() < since) return [`${kind} (the last one is older than the merged commit)`]
    return []
  })
}

interface InlineEvidence {
  kind: EvidenceKind
  link?: string
  note?: string
}

/**
 * `ship`: the commits are real and merged, and every kind of evidence they require is on record, fresh. What the verb itself carries
 * (`--evidence`) is recorded first, and stays recorded when the verb is refused.
 */
export async function gateShip(context: Context): Promise<string | undefined> {
  const { tx, issue, row } = context
  const derived = derivedOf(context.row)
  if (!derived) return 'ship came without its commits derived'
  if (derived.problem) return derived.problem
  if (derived.commits.length === 0) return 'ship names no merged commit'
  const inline = (row.payload?.evidence ?? []) as InlineEvidence[]
  for (const [i, item] of inline.entries()) {
    await storeEvidence(tx, {
      issueId: issue.id,
      key: `${row.key}:${i}`,
      attempt: issue.attempt,
      kind: item.kind,
      link: item.link,
      payload: item.note ? { note: item.note } : null,
      at: row.at,
      author: row.session ?? 'owner',
    })
  }
  const missing = await missingEvidence(context, derived)
  if (missing.length === 0) return undefined
  const since = derived.mergedAt ? ` recorded after the merged commit (${derived.mergedAt})` : ''
  return `ship refused, evidence missing${since}: ${missing.join('; ')}. File each with \`factory issue evidence ${issue.id} --kind <kind> --link <url>\`, then ship again.`
}

/**
 * `close`: nothing deployed. Commits that touch deployable paths go through `ship`; with none, the proof is a commit the lead names, which
 * `derive` found merged, or the document. Something merely on the branch is neither.
 */
export async function gateClose({ issue, row }: Context): Promise<string | undefined> {
  const derived = derivedOf(row)
  if (!derived) return 'close came without its commits derived'
  if (derived.problem) return derived.problem
  if (derived.required.length > 0) {
    return `close refused: these commits touch deployable paths (${derived.required.join(', ')}: ${derived.paths.slice(0, 5).join(', ')}). Use \`factory issue ship ${issue.id}\` with its evidence.`
  }
  const named = Array.isArray(row.payload?.commits) && row.payload.commits.length > 0
  if (!named && typeof row.payload?.document !== 'string') {
    return 'close refused: name the commit (--commit <sha>) or the document (--document <path or url>) that is the proof'
  }
  return undefined
}

/** A green check's results go with the close they prove. */
export async function recordProof({ tx, issue, row }: Context): Promise<undefined> {
  await storeEvidence(tx, {
    issueId: issue.id,
    key: row.key,
    attempt: issue.attempt,
    kind: 'hold',
    payload: { hold: row.payload?.hold, checks: row.payload?.checks },
    at: row.at,
    author: 'factory',
  })
  return undefined
}
