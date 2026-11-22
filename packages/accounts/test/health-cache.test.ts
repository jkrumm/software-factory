import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gradeMachine, readHealthCache, writeHealthCache } from '../src/index.ts'

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-cache-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const NOW = Date.parse('2026-11-22T12:00:00Z')

describe('a login row carries when the login ends', () => {
  const graded = (severity: string, days: number) =>
    gradeMachine('mini', {
      usage: { default_account: 'iu', accounts: [{ id: 'me', auth_ok: true, age_s: 30 }] },
      expiry: {
        accounts: [{ id: 'me', severity, days_left: days, expired: false, refresh_expires_at: NOW + days * DAY }],
      },
      pending: null,
    })

  test('warn and ok alike, with the package grade untouched', () => {
    expect(graded('WARN', 6.9)).toEqual([
      {
        machine: 'mini',
        id: 'me',
        check: 'login',
        state: 'warn',
        detail: 'login ends in 6.9 d',
        fix: 'claude-relogin me --machine mini',
        ends_at: new Date(NOW + 6.9 * DAY).toISOString(),
        days_left: 6.9,
      },
    ])
    expect(graded('PASS', 28.1)).toMatchObject([
      { state: 'ok', detail: '28.1 d left', ends_at: new Date(NOW + 28.1 * DAY).toISOString(), days_left: 28.1 },
    ])
  })

  test('an unreadable expiry has no date', () => {
    const [row] = gradeMachine('mini', {
      usage: { default_account: 'iu', accounts: [{ id: 'me', auth_ok: true, age_s: 30 }] },
      expiry: { accounts: [{ id: 'me', severity: 'WARN', days_left: null, expired: false, refresh_expires_at: null }] },
      pending: null,
    })
    expect(row).toMatchObject({ state: 'warn', detail: 'login expiry unreadable' })
    expect(row).not.toHaveProperty('ends_at')
  })
})

describe('the health cache', () => {
  const rows = gradeMachine('macbook', {
    usage: { default_account: 'iu', accounts: [{ id: 'me2', auth_ok: true, age_s: 7 * 3600 }] },
    expiry: {
      accounts: [{ id: 'me2', severity: 'PASS', days_left: 9, expired: false, refresh_expires_at: NOW + 9 * DAY }],
    },
    pending: null,
  })

  test('keeps the rows and when they were read', () => {
    const dir = tmp()
    expect(readHealthCache(dir)).toBeNull()
    writeHealthCache(rows, NOW, dir)
    expect(readHealthCache(dir)).toEqual({ at: '2026-11-22T12:00:00.000Z', rows })
    expect(rows.map((r) => r.check)).toEqual(['login', 'quota'])
  })

  test('a file that is not a cache reads as none', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'health.json'), JSON.stringify({ at: 'x', rows: [{ machine: 1 }] }))
    expect(readHealthCache(dir)).toBeNull()
    writeFileSync(join(dir, 'health.json'), '{half')
    expect(readHealthCache(dir)).toBeNull()
  })
})
