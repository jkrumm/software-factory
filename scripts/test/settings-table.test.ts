import { expect, test } from 'bun:test'
import { problemsIn, render, type Setting } from '../settings-table.ts'

const setting = (name: string, loader: string): Setting => ({ name, defaultValue: 'unset', tunes: 'x', loader })

test('a name two loaders declare is a problem, naming both', () => {
  const declared = [setting('PORT', 'a/settings.ts'), setting('PORT', 'b/settings.ts')]
  expect(problemsIn(render(declared), declared)).toEqual([
    'one loader owns each name: PORT is declared by a/settings.ts and b/settings.ts',
  ])
})

test('one loader per name, and a table that says so, is clean', () => {
  const declared = [setting('HOME', 'b/settings.ts'), setting('PORT', 'a/settings.ts')]
  expect(problemsIn(render(declared), declared)).toEqual([])
})
