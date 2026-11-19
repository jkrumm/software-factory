import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPaths } from '@software-factory/accounts'

export const NOW = new Date('2026-11-19T12:00:00Z')
const NOW_S = NOW.getTime() / 1000
const HOUR_S = 3600
const IDS = ['a', 'b', 'c', 'd'] as const

export interface Window {
  s?: number
  w: number
  /** hours until the weekly reset */
  wIn?: number
}

const made: string[] = []

/** Removes every directory a fixture made. */
export const cleanFixtures = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A fresh directory with a registry (the default account disabled, four bulk accounts) and a sample per account. */
export function accountsFixture(
  samples: Record<(typeof IDS)[number], Window>,
  registryMode: Record<string, unknown> = {},
): AccountPaths {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-'))
  made.push(dir)
  const paths = {
    registry: join(dir, 'registry.json'),
    cacheDir: join(dir, 'cache'),
    modes: join(dir, 'modes.json'),
    history: join(dir, 'history'),
  }
  mkdirSync(paths.cacheDir, { recursive: true })
  const accounts: Record<string, unknown> = {
    iu: { dir: null, plan: 'max5x', homeLanes: ['interactive'], enabled: false },
  }
  for (const id of IDS) {
    accounts[id] = {
      dir: join(dir, id),
      plan: 'max5x',
      homeLanes: ['bulk'],
      enabled: true,
      ...(registryMode[id] ? { mode: registryMode[id] } : {}),
    }
    const x = samples[id]
    const ts = NOW.getTime() - 60_000
    writeFileSync(
      join(paths.cacheDir, `${id}.sample.json`),
      JSON.stringify({
        s: x.s ?? 10,
        s_reset: NOW_S + 2 * HOUR_S,
        s_ts: ts,
        w: x.w,
        w_reset: NOW_S + (x.wIn ?? 96) * HOUR_S,
        w_ts: ts,
        src: 'statusline',
      }),
    )
  }
  writeFileSync(paths.registry, JSON.stringify({ version: 2, accounts, fable: null, drain: null }))
  return paths
}
