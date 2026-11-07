import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** What `agw factory-ask` accepts: more is refused, so the caller cuts. */
export const MAX_FACTS = 20_000
export const MAX_PLAN = 40_000

/** The repo's plan documents, in the order they are read; whichever exist are sent, cut to `MAX_PLAN` together. */
const PLAN_DOCS = ['AGENTS.md', 'docs/decisions.md', 'docs/program.md', 'docs/design.md'] as const

/** What is read of a document before it is scrubbed or cut: bounds the work on a huge file. */
const MAX_READ = 200_000

const REDACTED = '[redacted]'

/**
 * Credential-looking strings out of text that goes to a model provider and is journaled: private key blocks, `Bearer` tokens,
 * `key=value` pairs whose key names a secret, well-known token prefixes, `user:password@` in a URL and any long unbroken token.
 * A heuristic on top of the facts being data, not a guarantee: the visible repos send nothing at all.
 */
export function scrub(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',}&]{4,}/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{10,}/g, REDACTED)
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${REDACTED}@`)
    .replace(/\b[A-Za-z0-9_-]{41,}\b/g, REDACTED)
}

/** The Issue's words and facts as one scrubbed string of at most `MAX_FACTS` characters. */
export function factsOf(issue: { title: string; facts: unknown }): string {
  const facts = (JSON.stringify(issue.facts) ?? '{}').slice(0, MAX_READ)
  return scrub(`title: ${issue.title}\nfacts: ${facts}`).slice(0, MAX_FACTS)
}

/** The plan documents of the repo that exist, each under its path, cut to `MAX_PLAN` together. Reads files; never inside a transaction. */
export async function planOf(repoPath: string): Promise<string> {
  const parts: string[] = []
  let size = 0
  for (const doc of PLAN_DOCS) {
    if (size >= MAX_PLAN) break
    let body: string
    try {
      body = (await readFile(join(repoPath, doc), 'utf8')).slice(0, MAX_READ)
    } catch {
      continue
    }
    const part = `## ${doc}\n${body}\n`
    parts.push(part)
    size += part.length
  }
  return parts.join('\n').slice(0, MAX_PLAN)
}

/** The repo as the workflow takes it: the directory's name, cut to what its pattern allows. */
export function repoName(repoPath: string): string {
  return (
    basename(repoPath)
      .replace(/[^A-Za-z0-9._/-]/g, '-')
      .slice(0, 200) || 'repo'
  )
}
