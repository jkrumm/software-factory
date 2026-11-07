import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_INFRA_FILE, DEFAULT_THRESHOLDS, loadInfra, parseInfra } from '../src/intake/infra.ts'

describe('config/infra.json', () => {
  test('the shipped file loads: three hosts, the mini local, the documented defaults', async () => {
    expect(DEFAULT_INFRA_FILE).toMatch(/\/config\/infra\.json$/)
    const infra = await loadInfra()
    expect(infra.refileAfterMin).toBe(360)
    expect([...infra.hosts.keys()]).toEqual(['macmini', 'homelab', 'vps'])
    expect(infra.hosts.get('macmini')).toMatchObject({ repo: 'dotfiles', local: true })
    expect(infra.hosts.get('homelab')).toMatchObject({ repo: 'homelab', local: false })
    expect(infra.hosts.get('vps')?.repo).toBe('vps')
    expect(infra.hosts.get('vps')?.thresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  test('a host overrides single numbers, the rest stays', () => {
    const infra = parseInfra(
      JSON.stringify({
        defaults: { swap: { usedGb: 6 } },
        hosts: { a: { repo: 'x', thresholds: { swap: { sustainMin: 5 } } } },
      }),
    )
    expect(infra.hosts.get('a')?.thresholds.swap).toEqual({ usedGb: 6, sustainMin: 5, clearMin: 10 })
  })

  test('a bad file is an error naming the field', () => {
    expect(() => parseInfra(JSON.stringify({ hosts: { a: { repo: '../x' } } }))).toThrow('hosts.a.repo')
    expect(() => parseInfra(JSON.stringify({ hosts: { A: { repo: 'x' } } }))).toThrow('hosts.A')
    expect(() => parseInfra(JSON.stringify({ defaults: { swap: { usedGb: -1 } }, hosts: {} }))).toThrow(
      'defaults.swap.usedGb',
    )
    expect(() => parseInfra(JSON.stringify({ defaults: { swap: { typo: 1 } }, hosts: {} }))).toThrow('defaults.swap')
  })

  test('loadInfra names the file when it is missing or unusable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'infra-'))
    try {
      expect(String(await loadInfra(join(dir, 'none.json')).catch((e: unknown) => e))).toContain('cannot be read')
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ hosts: { a: {} } }))
      expect(String(await loadInfra(join(dir, 'bad.json')).catch((e: unknown) => e))).toContain('hosts.a.repo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
