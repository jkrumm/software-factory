import type { SQL } from 'bun'
import { api } from './seed.ts'

interface FlowIssues {
  states: Record<string, { issues: { id: string; repo: string }[] }>
}

const DIGESTED = ['argo', 'harbor']

/**
 * A digest for two projects, as the digest loop would store them (the loop's own calls are the scenarios'; the fake agw has
 * nothing worth showing here), citing the Issues the seed filed there, so the strip has words and links to open. The loop
 * is off in the e2e world, so these rows are the newest each project has.
 */
export async function seedDigests(url: string, sql: SQL, now = new Date()): Promise<Record<string, string[]>> {
  const flow = await api<FlowIssues>(url, '/v1/flow')
  const open = Object.values(flow.states).flatMap((column) => column.issues)
  const cited: Record<string, string[]> = {}
  for (const project of DIGESTED) {
    const ids = open.filter((issue) => issue.repo === project).map((issue) => issue.id)
    const [first, second] = ids
    if (!first) throw new Error(`the seed left no open Issue in ${project}`)
    cited[project] = ids.slice(0, 2)
    const digest = {
      headline: `${project} is mid-migration: two Issues run and the rest wait behind them`,
      shipped: [{ text: 'The retention policy landed and the audit rows are pruned nightly', ids: [first] }],
      next: [{ text: 'The cache store is picked, then the queue spec follows', ids: [second ?? first] }],
      risks: [{ text: 'Both leads wait on a Decision that has no default yet', ids: ids.slice(0, 2) }],
      themes: ['retention', 'cache'],
    }
    await sql`
      INSERT INTO factory.project_digests (project, at, input_hash, route, digest)
      VALUES (${project}, ${new Date(now.getTime() - 95 * 60_000)}, ${`e2e-${project}`}, 'factory.digest', ${JSON.stringify(digest)}::text::jsonb)`
  }
  return cited
}
