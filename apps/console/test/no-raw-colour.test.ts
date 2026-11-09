import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { rawColours } from './raw-colour.ts'

const root = join(import.meta.dir, '..')
/** The generated files and the validated chart palette (`series.css`, the one place a series colour is written). */
const GENERATED = new Set(['src/styles/tokens.css', 'src/styles/series.css', 'src/routeTree.gen.ts'])
const SOURCE = /\.(ts|tsx|css)$/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return SOURCE.test(entry.name) ? [path] : []
  })
}

test('no colour literal outside the generated tokens', () => {
  const files = [...sources(join(root, 'src')), join(root, 'index.html'), join(root, 'vite.config.ts')]
  const found = files
    .map((file) => relative(root, file))
    .filter((file) => !GENERATED.has(file))
    .flatMap((file) => rawColours(readFileSync(join(root, file), 'utf8')).map((colour) => `${file}: ${colour}`))
  expect(found).toEqual([])
})
