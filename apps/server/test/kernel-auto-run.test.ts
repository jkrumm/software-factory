import { describe, expect, test } from 'bun:test'
import { AUTO_RUN_EVIDENCE, AUTO_RUN_NOTE, AUTO_RUN_NOTE_PATTERN, autoRunClassOf } from '../src/kernel/auto-run.ts'

describe('the auto-run evidence ask-human.sh writes when the MacBook gate ran a class by itself', () => {
  test('names the class', () => {
    const evidence =
      'ask-human: auto-run class secrets-seed, granted by the owner on the MacBook, ran it with no dialog'
    expect(autoRunClassOf(evidence)).toBe('secrets-seed')
    expect(autoRunClassOf(`  ${evidence}\n`)).toBe('secrets-seed')
    expect(autoRunClassOf(`${AUTO_RUN_EVIDENCE}secrets-seed`)).toBe('secrets-seed')
    expect(autoRunClassOf('ask-human: auto-run class secrets-seed (granted by the owner)')).toBe('secrets-seed')
  })

  test('anything else is not an auto-run', () => {
    expect(autoRunClassOf(null)).toBeNull()
    expect(autoRunClassOf(undefined)).toBeNull()
    expect(autoRunClassOf('the MacBook operator, who listed the folder')).toBeNull()
    expect(autoRunClassOf('ask-human: the owner clicked Run in the MacBook dialog')).toBeNull()
    expect(autoRunClassOf('ask-human: auto-run class , x')).toBeNull()
    expect(autoRunClassOf('ask-human: auto-run class Bad Name, x')).toBeNull()
  })

  test('the SQL pattern the KPI and the band read with agrees with the parser on every shape', () => {
    const pattern = new RegExp(AUTO_RUN_NOTE_PATTERN)
    expect(AUTO_RUN_NOTE).toBe('confirmed by ask-human: auto-run class ')
    for (const evidence of [
      'ask-human: auto-run class secrets-seed, ran it',
      'ask-human: auto-run class secrets-seed (granted by the owner)',
      'ask-human: auto-run class secrets-seed',
      'ask-human: auto-run class secrets-seed · exit 0',
      'ask-human: auto-run class , x',
      'ask-human: auto-run class Bad Name, x',
      'ask-human: the owner clicked Run in the MacBook dialog',
      'the MacBook operator, who listed the folder',
    ]) {
      expect([evidence, pattern.test(`${AUTO_RUN_NOTE.slice(0, 'confirmed by '.length)}${evidence}`)]).toEqual([
        evidence,
        autoRunClassOf(evidence) !== null,
      ])
    }
  })
})
