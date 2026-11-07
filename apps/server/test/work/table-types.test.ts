import { expect, test } from 'bun:test'
import { EVENT_KINDS } from '../../src/domains/work/events.ts'
import { STATES } from '../../src/domains/work/issue.ts'
import { type Cell, TABLE, type Table } from '../../src/domains/work/table.ts'

/**
 * The table is total: these fixtures do not compile, and `tsc` fails if one ever does (an unused `@ts-expect-error` is
 * an error). This file is the one place oxlint allows the directive (`.oxlintrc.json` overrides).
 */
const settlingWithoutFiled: Omit<Table['settling'], 'filed'> = TABLE.settling

// @ts-expect-error: a missing cell, settling takes no filed, fails tsc
const missingCell: Table = { ...TABLE, settling: settlingWithoutFiled }

// @ts-expect-error: a missing state fails tsc
const missingState: Table = { settling: TABLE.settling }

const toNowhere = { to: 'paused', effects: [] }
// @ts-expect-error: a cell may move only to a state of the machine
const strayState: Cell = toNowhere

const closedNoOutcome = { to: 'closed', effects: [] }
// @ts-expect-error: a move to closed names its outcome
const closedWithoutOutcome: Cell = closedNoOutcome

test('the fixtures exist, and the real table has a cell for every state and event', () => {
  expect([missingCell, missingState, strayState, closedWithoutOutcome].length).toBe(4)
  for (const state of STATES) {
    expect(Object.keys(TABLE[state]).sort()).toEqual([...EVENT_KINDS].sort())
    for (const kind of EVENT_KINDS) expect(typeof TABLE[state][kind]).toBe('function')
  }
})
