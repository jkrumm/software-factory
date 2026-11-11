import type { ChainEdge, ChainModel, ChainNode } from '@software-factory/contract'

export const SCALE_PROJECT = 'basalt-ui'

/** A title a person would read: no internal id in it. */
const titleOf = (id: string): string => {
  const number = /^issue_(\d+)$/.exec(id)?.[1]
  if (number) return `Export step ${number}`
  return `Plan row ${id.slice(id.lastIndexOf(':') + 1)}`
}

const node = (
  id: string,
  repo: string,
  kind: 'issue' | 'row',
  state: string,
  extra: Partial<ChainNode> = {},
): ChainNode => ({
  id,
  kind,
  repo,
  title: titleOf(id),
  state,
  issueKind: 'feature',
  since: kind === 'issue' ? '2026-11-08T00:00:00.000Z' : null,
  waitReason: null,
  notBefore: null,
  ...extra,
})

/**
 * One project, 400 nodes: 5 open Issues, 40 closed Issues, `rows` plan rows in `depth` steps (step 1 waits for the last
 * open Issue, each next step for every row of the one before), and 3 rows that may file now. Dates on a few rows.
 */
export function seededChain(rows = 352, depth = 8): { nodes: ChainNode[]; edges: ChainEdge[] } {
  const nodes: ChainNode[] = []
  const edges: ChainEdge[] = []
  for (let i = 0; i < 40; i++)
    nodes.push(
      node(`issue_${i + 1}`, 'basalt-ui', 'issue', 'closed', {
        since: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    )
  for (let i = 0; i < 5; i++) {
    const id = `issue_${100 + i}`
    nodes.push(node(id, 'basalt-ui', 'issue', i === 0 ? 'working' : 'waiting'))
    // each open Issue followed eight closed ones, and waits for the previous open Issue
    for (let k = 0; k < 8; k++) edges.push({ from: id, to: `issue_${i * 8 + k + 1}`, closed: true })
    if (i > 0) edges.push({ from: id, to: `issue_${100 + i - 1}`, closed: false })
  }
  for (let i = 0; i < 3; i++) {
    nodes.push(node(`row:basalt-ui:ready-${i}`, 'basalt-ui', 'row', 'filable'))
    edges.push({ from: `row:basalt-ui:ready-${i}`, to: 'issue_1', closed: true })
  }
  const perStep = Math.ceil(rows / depth)
  for (let step = 1; step <= depth; step++) {
    for (let i = 0; i < perStep && nodes.length < 400; i++) {
      const id = `row:basalt-ui:s${step}-${i}`
      const dated = i === 0 ? { notBefore: `2026-12-${String(step + 10)}T09:00:00Z` } : {}
      nodes.push(node(id, 'basalt-ui', 'row', 'waiting', dated))
      if (step === 1) edges.push({ from: id, to: 'issue_104', closed: false })
      else edges.push({ from: id, to: `row:basalt-ui:s${step - 1}-${i % perStep}`, closed: false })
    }
  }
  return { nodes, edges }
}

/** The same chain as the API's read model, for a route that answers `GET /v1/chain` with it. */
export const scaleModel = (): ChainModel => ({
  at: new Date().toISOString(),
  ...seededChain(),
  blocking: {},
})
