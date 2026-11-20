import { describe, expect, test } from 'bun:test'
import { ErrandScreenRequest } from '../src/checkpoints.ts'

const issue = { id: 'issue_1', repo: 'r', title: 't', kind: 'chore' }

describe('the Errand screen request', () => {
  test('a long body parses, with its command, machine and need as fields', () => {
    const errand = {
      id: 'errand_1',
      summary: 'Deploy it',
      detail: 'x'.repeat(6000),
      command: 'make deploy',
      host: 'macbook',
      need: 'place',
    }
    expect(ErrandScreenRequest.safeParse({ errand, issue }).success).toBe(true)
  })

  test('the fields are required, null when there is none', () => {
    const bare = { id: 'errand_1', summary: 'Plug it in', detail: null }
    expect(ErrandScreenRequest.safeParse({ errand: bare, issue }).success).toBe(false)
    expect(
      ErrandScreenRequest.safeParse({ errand: { ...bare, command: null, host: null, need: null }, issue }).success,
    ).toBe(true)
  })

  test("a body past the screen workflow's own limit is refused", () => {
    const errand = { id: 'errand_1', summary: 's', detail: 'x'.repeat(8001), command: null, host: null, need: null }
    expect(ErrandScreenRequest.safeParse({ errand, issue }).success).toBe(false)
  })
})
