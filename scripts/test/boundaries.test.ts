import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { checkBoundaries, importsOf, SERVER_SRC } from '../boundaries.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A server `src` tree from a map of path to source; the rules' answer for it. */
async function check(files: Record<string, string>) {
  root = await mkdtemp('/tmp/factory-boundaries-')
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return (await checkBoundaries(root)).map((v) => `${v.file}: ${v.rule}`)
}

/** Each rule: a tree that breaks it and the nearest tree that keeps it. */
const RULES: { rule: string; failing: Record<string, string>; passing: Record<string, string> }[] = [
  {
    rule: 'kernel imports nothing of the server',
    failing: { 'kernel/ids.ts': "import { x } from '../adapters/postgres/db.ts'\n" },
    passing: { 'kernel/ids.ts': "import { ok } from './result.ts'\n", 'kernel/result.ts': '' },
  },
  {
    rule: 'a domain imports only kernel and its own folder',
    failing: { 'domains/work/issue.ts': "import { signal } from '../intake/signal.ts'\n" },
    passing: {
      'domains/work/issue.ts': "import { ok } from '../../kernel/result.ts'\nimport { cell } from './table.ts'\n",
    },
  },
  {
    rule: 'a domain imports only kernel and its own folder',
    failing: { 'domains/work/issue.ts': "import { repo } from '../../adapters/postgres/issues.ts'\n" },
    passing: { 'domains/work/issue.ts': "import type { Port } from './ports.ts'\n" },
  },
  {
    rule: 'a domain does no I/O: no elysia, SQL client, node:fs or bun module',
    failing: { 'domains/work/a.ts': "import { Elysia } from 'elysia'\n" },
    passing: { 'domains/work/a.ts': "import * as z from 'zod'\n" },
  },
  {
    rule: 'a domain does no I/O: no elysia, SQL client, node:fs or bun module',
    failing: { 'domains/work/a.ts': "import { readFile } from 'node:fs/promises'\nimport { SQL } from 'bun'\n" },
    passing: { 'domains/work/a.ts': "import { join } from 'node:path'\n" },
  },
  {
    rule: 'a domain does no I/O: no Bun.* I/O',
    failing: { 'domains/work/a.ts': "export const read = () => Bun.file('x').text()\n" },
    passing: { 'domains/work/a.ts': '// Bun.file is for adapters\nexport const h = (s: string) => Bun.hash(s)\n' },
  },
  {
    rule: 'a domain does no I/O: no fetch',
    failing: { 'domains/work/a.ts': "export const get = () => fetch('http://localhost')\n" },
    passing: { 'domains/work/a.ts': 'export const fetched = true\n' },
  },
  {
    rule: 'only app/ imports from more than one domain',
    failing: {
      'api/issues.ts': "import { a } from '../domains/work/a.ts'\nimport { b } from '../domains/intake/b.ts'\n",
    },
    passing: {
      'app/receive.ts': "import { a } from '../domains/work/a.ts'\nimport { b } from '../domains/intake/b.ts'\n",
      'api/issues.ts': "import { a } from '../domains/work/a.ts'\n",
    },
  },
  {
    rule: 'read/ imports only types from a domain, never code that writes',
    failing: { 'read/flow.ts': "import { apply } from '../domains/work/machine.ts'\n" },
    passing: { 'read/flow.ts': "import type { State } from '../domains/work/machine.ts'\n" },
  },
  {
    rule: 'read/ imports no use case: they write',
    failing: { 'read/flow.ts': "import { receive } from '../app/receive.ts'\n" },
    passing: { 'read/flow.ts': "import { healthOf } from './health.ts'\n" },
  },
  {
    rule: 'read/ is read-only: no SQL that writes',
    failing: { 'read/flow.ts': 'export const q = `UPDATE factory.issues SET state = 1`\n' },
    passing: { 'read/flow.ts': 'export const q = `SELECT state FROM factory.issues -- updated_at`\n' },
  },
  {
    rule: 'only app/ and the Postgres unit of work and migration runner open a transaction',
    failing: { 'adapters/postgres/work-store.ts': 'export const f = (sql) => sql.begin(async (tx) => tx`SELECT 1`)\n' },
    passing: {
      'adapters/postgres/unit-of-work.ts': 'export const run = (sql) => sql.begin(async (tx) => tx`SELECT 1`)\n',
      'adapters/postgres/migrate.ts': 'export const migrate = (sql) => sql.begin(async () => {})\n',
      'adapters/postgres/work-store.ts': "// sql.begin is the unit of work's\nexport const begun = true\n",
    },
  },
  {
    rule: 'only app/ and the Postgres unit of work and migration runner open a transaction',
    failing: { 'main.ts': 'await sql.transaction(async () => {})\n', 'api/issues.ts': 'await db.begin(() => 1)\n' },
    passing: { 'app/issues.ts': 'await uow.begin(() => 1)\n', 'main.ts': 'export const beginning = 1\n' },
  },
  {
    rule: 'app/ imports no adapter: it gets ports, main.ts composes them',
    failing: { 'app/issues.ts': "import { postgresWorkStore } from '../adapters/postgres/work-store.ts'\n" },
    passing: {
      'app/issues.ts': "import type { WorkStore } from '../domains/work/ports.ts'\n",
      'main.ts': "import { postgresWorkStore } from './adapters/postgres/work-store.ts'\n",
    },
  },
]

describe('every rule has a failing and a passing fixture', () => {
  for (const [i, { rule, failing, passing }] of RULES.entries()) {
    test(`${rule} (${i})`, async () => {
      expect((await check(failing)).some((line) => line.endsWith(rule))).toBe(true)
      await rm(root ?? '', { recursive: true, force: true })
      expect(await check(passing)).toEqual([])
    })
  }
})

test('folders that do not exist yet hold', async () => {
  expect(await check({})).toEqual([])
  expect(await checkBoundaries('/tmp/factory-no-such-dir')).toEqual([])
})

test("the server's own tree holds", async () => {
  expect(await checkBoundaries(SERVER_SRC)).toEqual([])
})

test('importsOf reads static, type-only, re-exported and dynamic imports, not comments', () => {
  const source = [
    "import type { A } from './a.ts'",
    "import {\n  b,\n  c,\n} from './b.ts'",
    "export { d } from './d.ts'",
    "import './side.ts'",
    "const e = await import('./e.ts')",
    "// import { f } from './f.ts'",
    "export const g = 'not an import'",
  ].join('\n')
  expect(importsOf(source)).toEqual([
    { specifier: './a.ts', typeOnly: true },
    { specifier: './b.ts', typeOnly: false },
    { specifier: './d.ts', typeOnly: false },
    { specifier: './side.ts', typeOnly: false },
    { specifier: './e.ts', typeOnly: false },
  ])
})
