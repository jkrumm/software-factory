import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseShard, planShards, readWeights, staleWeights, SUITES, suiteFiles } from '../shard.ts'

const ROOT = join(import.meta.dir, '..', '..')

describe('planShards', () => {
  test('puts the heaviest file first on the lightest shard, ties by name, and is deterministic', () => {
    const weights = { 'a.ts': 10, 'b.ts': 10, 'c.ts': 6, 'd.ts': 5, 'e.ts': 5 }
    const files = Object.keys(weights)
    const plan = planShards({ files, weights, total: 2 })
    expect(plan).toEqual([
      ['a.ts', 'c.ts'],
      ['b.ts', 'd.ts', 'e.ts'],
    ])
    expect(planShards({ files, weights, total: 2 })).toEqual(plan)
  })

  test('every file lands in exactly one shard, one without a weight counts as the median', () => {
    const weights = { 'a.ts': 3, 'b.ts': 9, 'c.ts': 1 }
    const files = ['a.ts', 'b.ts', 'c.ts', 'new.ts']
    const plan = planShards({ files, weights, total: 3 })
    expect(plan.flat().sort()).toEqual(files)
    expect(plan.find((shard) => shard.includes('b.ts'))).toEqual(['b.ts'])
  })
})

describe('staleWeights', () => {
  test('names a weight without a file, and not a file without a weight', () => {
    expect(staleWeights({ files: ['a.ts', 'b.ts'], weights: { 'a.ts': 1, 'gone.ts': 2 } })).toEqual(['gone.ts'])
  })
})

describe('parseShard', () => {
  test('reads i/n and refuses the rest', () => {
    expect(parseShard('2/3')).toEqual({ current: 2, total: 3 })
    for (const bad of [undefined, '', '0/3', '4/3', 'x']) expect(() => parseShard(bad)).toThrow('usage')
  })
})

describe('the committed weights', () => {
  for (const [name, suite] of Object.entries(SUITES)) {
    test(`${name}: name no missing file, and the three shards come out within 20% of each other`, async () => {
      const files = await suiteFiles({ root: ROOT, suite })
      const weights = await readWeights({ root: ROOT, suite })
      expect(staleWeights({ files, weights })).toEqual([])
      const loads = planShards({ files, weights, total: 3 }).map((shard) =>
        shard.reduce((sum, file) => sum + (weights[file] ?? 0), 0),
      )
      expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.2)
    })
  }
})
