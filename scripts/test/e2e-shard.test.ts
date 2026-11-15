import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { checkWeights, e2eFiles, parseShard, planShards, readWeights } from '../e2e-shard.ts'

const ROOT = join(import.meta.dir, '..', '..')

describe('planShards', () => {
  test('puts the heaviest file first on the lightest shard, ties by name, and is deterministic', () => {
    const weights = { 'a.e2e.ts': 10, 'b.e2e.ts': 10, 'c.e2e.ts': 6, 'd.e2e.ts': 5, 'e.e2e.ts': 5 }
    const plan = planShards({ weights, total: 2 })
    expect(plan).toEqual([
      ['a.e2e.ts', 'c.e2e.ts'],
      ['b.e2e.ts', 'd.e2e.ts', 'e.e2e.ts'],
    ])
    expect(planShards({ weights, total: 2 })).toEqual(plan)
  })

  test('every file lands in exactly one shard', () => {
    const weights = { 'a.e2e.ts': 3, 'b.e2e.ts': 9, 'c.e2e.ts': 1 }
    expect(planShards({ weights, total: 3 }).flat().sort()).toEqual(Object.keys(weights))
  })
})

describe('checkWeights', () => {
  test('names a file without a weight and a weight without a file', () => {
    const problems = checkWeights({ files: ['a.e2e.ts', 'b.e2e.ts'], weights: { 'a.e2e.ts': 1, 'gone.e2e.ts': 2 } })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('b.e2e.ts has no weight')
    expect(problems[1]).toContain('gone.e2e.ts')
  })
})

describe('parseShard', () => {
  test('reads i/n and refuses the rest', () => {
    expect(parseShard('2/3')).toEqual({ current: 2, total: 3 })
    for (const bad of [undefined, '', '0/3', '4/3', 'x']) expect(() => parseShard(bad)).toThrow('usage')
  })
})

describe('the committed weights', () => {
  test('weigh every e2e file and nothing else, and the three shards come out within 15% of each other', async () => {
    const weights = await readWeights(ROOT)
    expect(checkWeights({ files: await e2eFiles(ROOT), weights })).toEqual([])
    const loads = planShards({ weights, total: 3 }).map((files) =>
      files.reduce((sum, file) => sum + (weights[file] ?? 0), 0),
    )
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.15)
  })
})
