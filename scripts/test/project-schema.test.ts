import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { projectJsonSchema } from '../../packages/contract/src/project-file.ts'
import { keyRows, PAGE_FILE, pageWithReference, referenceText, SCHEMA_FILE, schemaText } from '../project-schema.ts'

describe('project.yaml generated files', () => {
  test('schema/project.schema.json is what the schema generates now', async () => {
    expect(await readFile(SCHEMA_FILE, 'utf8')).toBe(schemaText())
  })

  test("docs/project.md's key reference is what the schema generates now", async () => {
    const page = await readFile(PAGE_FILE, 'utf8')
    expect(pageWithReference(page)).toBe(page)
  })

  test('a key added to the schema without regenerating is a stale schema file and a stale page', async () => {
    const schema = projectJsonSchema()
    const properties = schema.properties as Record<string, unknown>
    const grown = {
      ...schema,
      properties: { ...properties, queue: { type: 'string', description: 'a new key', consumer: 'nobody yet' } },
    }
    expect(`${JSON.stringify(grown, null, 2)}\n`).not.toBe(await readFile(SCHEMA_FILE, 'utf8'))
    const page = await readFile(PAGE_FILE, 'utf8')
    expect(pageWithReference(page, referenceText(keyRows(grown)))).not.toBe(page)
  })

  test('every key the reference lists names its consumer, and the page lists no key the schema lacks', async () => {
    const rows = keyRows()
    expect(rows.filter((row) => row.consumer === '—').map((row) => row.path)).toEqual([])
    const listed = [...(await readFile(PAGE_FILE, 'utf8')).matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1])
    expect(listed.toSorted()).toEqual(rows.map((row) => row.path).toSorted())
  })
})
