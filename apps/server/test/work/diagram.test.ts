import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { DIAGRAM_END, DIAGRAM_START, issueDiagram, withDiagram } from '../../src/domains/work/diagram.ts'

const LANGUAGE = join(import.meta.dir, '..', '..', '..', '..', 'docs', 'language.md')

test('the diagram in docs/language.md is the one TABLE makes', async () => {
  const document = await Bun.file(LANGUAGE).text()
  expect(withDiagram(document)).toBe(document)
})

test('a stale block is replaced, and a document without markers is refused', () => {
  const stale = `# x\n\n${DIAGRAM_START}\nold\n${DIAGRAM_END}\n`
  expect(withDiagram(stale)).toBe(`# x\n\n${issueDiagram()}\n`)
  expect(withDiagram('# no markers\n')).toBeNull()
})

test('the diagram is a Mermaid state diagram with every state', () => {
  const block = issueDiagram()
  expect(block).toContain('stateDiagram-v2')
  for (const edge of ['[*] --> settling: filed', 'closed --> queued: reopened', 'watching --> closed: watch_passed']) {
    expect(block).toContain(edge)
  }
})
