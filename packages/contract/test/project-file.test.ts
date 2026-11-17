import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv from 'ajv'
import { parse } from 'yaml'
import { parseYamlText } from '../src/plan-file.ts'
import { ProjectFile, projectJsonSchema, StoredProjectFile } from '../src/project-file.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'projects')
const ROOT = join(import.meta.dir, '..', '..', '..')

/** The JSON Schema as an editor reads it: `consumer` is ours, so the validator is told it is a keyword. */
function validator() {
  const ajv = new Ajv({ allErrors: true, strict: true })
  ajv.addKeyword({ keyword: 'consumer', schemaType: 'string' })
  return ajv.compile(projectJsonSchema())
}

const fixtures = async (): Promise<{ name: string; value: unknown }[]> => {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.yaml')).sort()
  return Promise.all(
    names.map(async (name) => {
      const read = parseYamlText(await readFile(join(FIXTURES, name), 'utf8'))
      if (!read.ok) throw new Error(`${name}: ${read.message}`)
      return { name, value: read.value }
    }),
  )
}

describe('project.yaml schema', () => {
  test('the JSON Schema and the zod schema both accept every repo file the factory reads (28, copied 2026-11-17)', async () => {
    const all = await fixtures()
    expect(all).toHaveLength(28)
    const validate = validator()
    for (const { name, value } of all) {
      expect({ name, valid: validate(value), errors: validate.errors ?? null }).toEqual({
        name,
        valid: true,
        errors: null,
      })
      expect({ name, ok: ProjectFile.safeParse(value).success }).toEqual({ name, ok: true })
    }
  })

  test("this repo's own project.yaml is valid by both", async () => {
    const value: unknown = parse(await readFile(join(ROOT, 'project.yaml'), 'utf8'))
    expect(validator()(value)).toBe(true)
    expect(ProjectFile.safeParse(value).success).toBe(true)
  })

  test('both refuse a typo, under signals too, and a value of the wrong form', () => {
    const validate = validator()
    const base = { apiVersion: 'factory/v2', name: 'lab' }
    for (const bad of [
      { ...base, signal: {} },
      { ...base, signals: { githb: { checks: true } } },
      { ...base, signals: { kuma: ['web'] } },
      { ...base, deploy: { hold: '30 minutes' } },
      { ...base, lanes: { Apple: 1 } },
      { ...base, checks: { fast: 'bun test' } },
    ]) {
      expect({ bad, json: validate(bad) }).toEqual({ bad, json: false })
      expect({ bad, zod: ProjectFile.safeParse(bad).success }).toEqual({ bad, zod: false })
    }
  })

  test('retired keys are deprecated in the JSON Schema, accepted and dropped by the parse', () => {
    const schema = JSON.stringify(projectJsonSchema())
    expect(schema.match(/"deprecated":true/g)?.length).toBe(4)
    const parsed = ProjectFile.parse({
      apiVersion: 'factory/v2',
      name: 'lab',
      deploy: { migrations: ['db/'], targets: [{ name: 'mini', host: 'mini', verify: 'make verify' }] },
      ship: [{ paths: ['**'], via: 'pr' }],
    })
    expect(parsed.deploy).toEqual({
      mode: 'none',
      targets: [{ name: 'mini', host: 'mini', verify: 'make verify' }],
      hold: '0m',
      paths: [],
      probes: [],
    })
    expect(parsed.ship).toEqual([{ via: 'pr' }])
  })

  test('a stored project reads back through StoredProjectFile unchanged; the author schema does not take a stored lane', () => {
    const parsed = ProjectFile.parse({
      apiVersion: 'factory/v2',
      name: 'lab',
      lanes: { apple: 1, round: { leads: 1, memory: '6GiB' } },
    })
    expect(parsed.lanes).toEqual({ apple: { leads: 1, memoryMib: null }, round: { leads: 1, memoryMib: 6144 } })
    const stored: unknown = JSON.parse(JSON.stringify(parsed))
    expect(StoredProjectFile.parse(stored)).toEqual(parsed)
    expect(ProjectFile.safeParse(stored).success).toBe(false)
  })

  test('a step declares its target, needs and whether it may leave the mini; no host is named in the file', () => {
    const parsed = ProjectFile.parse({
      apiVersion: 'factory/v2',
      name: 'lab',
      steps: { unit: { make: 'test', remote: true, carry: ['packages/x/dist'] }, lint: { make: 'lint' } },
    })
    expect(parsed.steps).toEqual({
      unit: { make: 'test', needs: [], remote: true, carry: ['packages/x/dist'] },
      lint: { make: 'lint', needs: [], remote: false, carry: [] },
    })
    expect(ProjectFile.parse({ apiVersion: 'factory/v2', name: 'lab' }).steps).toEqual({})
  })

  test('a step that needs what only the mini has cannot leave it, and a browser off the mini needs its own image', () => {
    const step = (value: unknown) =>
      ProjectFile.safeParse({ apiVersion: 'factory/v2', name: 'lab', steps: { s: value } })
    for (const need of ['apple', 'mac', 'secrets', 'services']) {
      expect(step({ needs: [need], remote: true }).success).toBe(false)
      expect(step({ needs: [need] }).success).toBe(true)
    }
    expect(step({ needs: ['browser'], remote: true }).success).toBe(false)
    expect(step({ needs: ['browser'], remote: true, dockerfile: 'tests/step.Dockerfile' }).success).toBe(true)
    expect(step({ needs: ['git', 'network'], remote: true }).success).toBe(true)
    expect(step({ remote: true, carry: ['../outside'] }).success).toBe(false)
    expect(step({ runs: ['vps'] }).success).toBe(false)
  })

  test('a row stored while signals was loose still reads back, its kuma and hyperdx dropped', () => {
    const row = {
      ...ProjectFile.parse({ apiVersion: 'factory/v2', name: 'lab' }),
      signals: { kuma: ['web'], hyperdx: {} },
    }
    expect(StoredProjectFile.parse(row).signals).toEqual({})
  })
})
