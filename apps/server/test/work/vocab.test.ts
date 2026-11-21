import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ISSUE_ORIGINS, ISSUE_OUTCOMES, ISSUE_STATES } from '@software-factory/contract'

/** A database CHECK repeats a vocabulary by necessity (an applied migration is never edited); it must stay the contract's list. */
const checkList = (file: string, column: string): string[] => {
  const sql = readFileSync(join(import.meta.dir, '../../migrations', file), 'utf8')
  const list = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql)?.[1]
  if (!list) throw new Error(`${file}: no CHECK on ${column}`)
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
}

test('the CHECK lists in the migrations are the contract vocabularies', () => {
  expect(checkList('0002_work.sql', 'state')).toEqual([...ISSUE_STATES])
  expect(checkList('0002_work.sql', 'outcome')).toEqual([...ISSUE_OUTCOMES])
  expect(checkList('0200_intake.sql', 'origin')).toEqual([...ISSUE_ORIGINS])
})
