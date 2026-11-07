import { describe, expect, test } from 'bun:test'
import { openapiDocument, operationsOf, render } from '../scripts/generate.ts'

const health = (operationId: string, ref = '#/$defs/Health') => ({
  get: {
    operationId,
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } },
  },
})

describe('operationsOf', () => {
  test("the server's document yields health get, and every domain's commands beside it", async () => {
    const operations = operationsOf(await openapiDocument())
    // every domain package adds its own operations to this document, so the test names the ones it needs
    expect(operations.map((op) => op.command.join(' '))).toContain('health get')
    expect(render(operations)).toContain('responses: { 200: Health, 503: Health }')
  })

  test('an operationId that is not <group>.<verb> fails', () => {
    expect(() => operationsOf({ paths: { '/health': health('getHealth') } })).toThrow('is not <group>.<verb>')
  })

  test('an answer without a contract schema id fails', () => {
    expect(() => operationsOf({ paths: { '/health': health('health.get', '#/$defs/Nope') } })).toThrow(
      'not a contract schema',
    )
    expect(() =>
      operationsOf({ paths: { '/x': { get: { operationId: 'x.get', responses: { '204': { description: '' } } } } } }),
    ).toThrow('no body')
  })

  test('a group a hand-written verb owns fails', () => {
    expect(() => operationsOf({ paths: { '/v': health('role.get') } })).toThrow('hand-written verb')
  })

  test('a query parameter named like a flag the CLI owns fails', () => {
    const op = health('x.get').get
    expect(() =>
      operationsOf({ paths: { '/x': { get: { ...op, parameters: [{ name: 'format', in: 'query' }] } } } }),
    ).toThrow('a flag the CLI owns')
  })

  test('two operations with one command fail', () => {
    expect(() => operationsOf({ paths: { '/a': health('health.get'), '/b': health('health.get') } })).toThrow(
      'two operations',
    )
  })

  test('path and query parameters and a body are recorded', () => {
    const [op] = operationsOf({
      paths: {
        '/issues/{id}/notes': {
          post: {
            operationId: 'issue.note',
            parameters: [
              { name: 'id', in: 'path' },
              { name: 'wake', in: 'query' },
            ],
            requestBody: {},
            responses: {
              '200': { description: '', content: { 'application/json': { schema: { $ref: '#/$defs/Health' } } } },
            },
          },
        },
      },
    })
    expect(op).toMatchObject({ method: 'POST', pathParams: ['id'], queryParams: ['wake'], body: true })
  })
})
