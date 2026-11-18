import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapHygieneDir } from '../../src/adapters/hygiene/checkout.ts'

describe('reapHygieneDir', () => {
  test('a boot removes the throwaway checkouts a killed pass left under the data directory, target and all', async () => {
    const data = mkdtempSync(join(tmpdir(), 'reap-'))
    const hygiene = join(data, 'hygiene')
    mkdirSync(join(hygiene, 'shutterflow-e3b8d5c-ClgeSk', 'target', 'debug'), { recursive: true })
    writeFileSync(join(hygiene, 'shutterflow-e3b8d5c-ClgeSk', 'target', 'debug', 'artifact'), 'x'.repeat(4096))
    mkdirSync(join(hygiene, 'software-factory-484d7c5-UwhmU6'))
    expect(await reapHygieneDir(data)).toBe(2)
    expect(readdirSync(hygiene)).toEqual([])
  })

  test('no hygiene directory yet is nothing to reap', async () => {
    const data = mkdtempSync(join(tmpdir(), 'reap-'))
    expect(await reapHygieneDir(data)).toBe(0)
  })
})
