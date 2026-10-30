import { describe, expect, test } from 'bun:test'
import { DEFAULT_ROLES_FILE, loadRoleTable, parseRoleTable } from '../src/roles.ts'

describe('config/roles.json', () => {
  test('is the table of the checkout, with every role the fleet uses', async () => {
    expect(DEFAULT_ROLES_FILE).toMatch(/\/config\/roles\.json$/)
    const table = await loadRoleTable()
    expect([...table.keys()]).toEqual([
      'mother',
      'lead',
      'wave',
      'worker',
      'mechanical',
      'implementer',
      'verifier',
      'Explore',
    ])
  })

  test('seeds from today: waves and workers Sonnet/high, the program lead Opus/high, sweeps Haiku', async () => {
    const table = await loadRoleTable()
    expect(table.get('wave')).toEqual({ role: 'wave', tier: 'sonnet', effort: 'high' })
    expect(table.get('worker')).toEqual({ role: 'worker', tier: 'sonnet', effort: 'high' })
    expect(table.get('lead')).toEqual({ role: 'lead', tier: 'opus', effort: 'high' })
    expect(table.get('mechanical')?.tier).toBe('haiku')
  })

  test('an entry prints as exactly role, tier, effort, in that order', async () => {
    expect(JSON.stringify((await loadRoleTable()).get('worker'))).toBe(
      '{"role":"worker","tier":"sonnet","effort":"high"}',
    )
  })
})

describe('parseRoleTable', () => {
  const table = (roles: unknown) => JSON.stringify({ roles })

  test.each([
    ['a model id instead of a tier', { x: { tier: 'claude-opus-5-5', effort: 'high' } }],
    ['an effort that does not exist', { x: { tier: 'opus', effort: 'ultra' } }],
    ['a role that is not a word', { 'a b': { tier: 'opus', effort: 'high' } }],
    ['a missing effort', { x: { tier: 'opus' } }],
  ])('refuses %s', (_name, roles) => {
    expect(() => parseRoleTable(table(roles))).toThrow()
  })

  test('refuses text that is not JSON', () => {
    expect(() => parseRoleTable('roles:')).toThrow()
  })

  test('loadRoleTable names the file it could not use', async () => {
    await expect(loadRoleTable('/nonexistent/roles.json')).rejects.toThrow('/nonexistent/roles.json')
  })
})
