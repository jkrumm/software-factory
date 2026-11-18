import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadInfra } from '../../src/adapters/intake/topology.ts'
import { parseInfra } from '../../src/domains/intake/infra.ts'

const SHIPPED = join(import.meta.dir, '../../../../config/infra.json')

describe('config/infra.json', () => {
  test('the shipped file loads: three hosts and the repo each one is routed to', async () => {
    const infra = await loadInfra(SHIPPED)
    expect([...infra.hosts.keys()]).toEqual(['macmini', 'homelab', 'vps'])
    expect(infra.hosts.get('macmini')).toEqual({ repo: 'dotfiles' })
    expect(infra.hosts.get('homelab')).toEqual({ repo: 'homelab' })
    expect(infra.hosts.get('vps')).toEqual({ repo: 'vps' })
  })

  test('a bad file is an error naming the field', () => {
    expect(() => parseInfra(JSON.stringify({ hosts: { a: { repo: '../x' } } }))).toThrow('hosts.a.repo')
    expect(() => parseInfra(JSON.stringify({ hosts: { A: { repo: 'x' } } }))).toThrow('hosts.A')
    expect(() => parseInfra(JSON.stringify({ defaults: {}, hosts: {} }))).toThrow('defaults')
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
