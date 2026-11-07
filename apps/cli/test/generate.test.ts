import { describe, expect, test } from 'bun:test'
import { bodyFieldsOf, kebab, openapiDocument, operationsOf, render } from '../scripts/generate.ts'

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
    expect(render(operations)).toMatch(/responses: \{ 200: Health, 500: ErrorBody, 503: Health \}/)
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

const withBody = (
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  required: true,
  content: {
    'application/json': {
      schema: {
        $ref: '#/$defs/B',
        $defs: { B: { type: 'object', properties, required, additionalProperties: false, ...extra } },
      },
    },
  },
})

const operationWith = (requestBody: unknown, parameters: unknown[] = []) => ({
  paths: {
    '/x/{id}': {
      post: {
        operationId: 'x.make',
        parameters: [{ name: 'id', in: 'path' }, ...parameters],
        requestBody,
        responses: {
          '200': { description: '', content: { 'application/json': { schema: { $ref: '#/$defs/Health' } } } },
        },
      },
    },
  },
})

describe('the flags of a body', () => {
  test('each JSON schema type maps to a kind', () => {
    const fields = bodyFieldsOf(
      withBody(
        {
          name: { type: 'string' },
          mode: { type: 'string', enum: ['a', 'b'] },
          ratio: { type: 'number' },
          attempt: { type: 'integer' },
          urgent: { type: 'boolean' },
          commits: { type: 'array', items: { type: 'string' } },
          sizes: { type: 'array', items: { type: 'integer' } },
          options: { type: 'array', items: { type: 'object' } },
          form: { type: 'object' },
          anything: {},
          maybe: { type: ['string', 'null'] },
          later: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        ['name', 'attempt'],
      ),
    )
    const kinds = Object.fromEntries(
      fields.map((f) => [f.name, `${f.kind}${f.repeatable ? '[]' : ''}${f.untyped ? '?' : ''}`]),
    )
    expect(kinds).toEqual({
      name: 'string',
      mode: 'string',
      ratio: 'number',
      attempt: 'integer',
      urgent: 'boolean',
      commits: 'string[]',
      sizes: 'integer[]',
      options: 'json',
      form: 'json',
      anything: 'json?',
      maybe: 'string',
      later: 'string',
    })
    expect(fields.filter((f) => f.required).map((f) => f.name)).toEqual(['name', 'attempt'])
  })

  test('a property with a default is not required, and a name becomes kebab-case', () => {
    const fields = bodyFieldsOf(
      withBody({ noAnswer: { type: 'string' }, worth_asking: { type: 'string', default: 'x' } }, [
        'noAnswer',
        'worth_asking',
      ]),
    )
    expect(fields.map((f) => [f.name, f.flag, f.required])).toEqual([
      ['noAnswer', 'no-answer', true],
      ['worth_asking', 'worth-asking', false],
    ])
    expect(kebab('fooBarBaz')).toBe('foo-bar-baz')
  })

  test('a refinement (allOf, anyOf) is still one object', () => {
    const body = {
      content: {
        'application/json': {
          schema: {
            $ref: '#/$defs/B',
            $defs: {
              B: {
                allOf: [
                  { $ref: '#/$defs/A' },
                  { type: 'object', properties: { b: { type: 'boolean' } }, required: ['b'] },
                ],
              },
              A: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            },
          },
        },
      },
    }
    expect(bodyFieldsOf(body).map((f) => [f.name, f.kind, f.required])).toEqual([
      ['a', 'string', true],
      ['b', 'boolean', true],
    ])
    const either = {
      content: {
        'application/json': {
          schema: {
            anyOf: [
              { type: 'object', properties: { a: { type: 'string' }, c: { type: 'string' } }, required: ['a', 'c'] },
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            ],
          },
        },
      },
    }
    expect(bodyFieldsOf(either).map((f) => [f.name, f.required])).toEqual([
      ['a', true],
      ['c', false],
    ])
  })

  test('an operation without an object body has no fields', () => {
    expect(bodyFieldsOf(undefined)).toEqual([])
    expect(bodyFieldsOf({})).toEqual([])
    expect(
      bodyFieldsOf({ content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } }),
    ).toEqual([])
  })

  test('a flag that collides with a path param, a query param or a reserved flag fails, naming the operation', () => {
    for (const [name, clash] of [
      ['id', 'a path parameter'],
      ['wake', 'a query parameter'],
      ['format', 'a flag the CLI owns'],
      ['help', 'a flag the CLI owns'],
      ['body', 'a flag the CLI owns'],
    ] as const) {
      expect(() =>
        operationsOf(operationWith(withBody({ [name]: { type: 'string' } }), [{ name: 'wake', in: 'query' }])),
      ).toThrow(new RegExp(`POST /x/\\{id\\}.*"${name}".*--${name}.*${clash}`))
    }
  })

  test('two properties with one flag fail', () => {
    expect(() =>
      operationsOf(operationWith(withBody({ fooBar: { type: 'string' }, foo_bar: { type: 'string' } }))),
    ).toThrow('rename it in the contract')
  })

  test('the generated file carries the fields of the real document', async () => {
    const operations = operationsOf(await openapiDocument())
    const close = operations.find((op) => op.operationId === 'issue.close')
    expect(close?.bodyFields.map((f) => [f.flag, f.kind, f.required])).toEqual([
      ['attempt', 'integer', true],
      ['outcome', 'string', true],
      ['reason', 'string', true],
      ['call', 'string', false],
    ])
  })
})
