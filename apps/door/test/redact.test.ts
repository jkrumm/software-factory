import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseHyperdx, parseKuma } from '../src/parsers.ts'
import { redactUrls, withoutUserinfo } from '../src/redact.ts'

const fixture = (name: string): Promise<unknown> => Bun.file(join(import.meta.dir, 'fixtures', name)).json()
const SECRETS = ['s3cret', 'hunter2', 'frag-token', 'dsn-pw', 'hook-key']

describe('redactUrls', () => {
  test('a URL keeps its scheme, host and path, and loses userinfo, query and fragment', () => {
    expect(redactUrls('connect failed https://svc:s3cret@db.example.com:5432/x?password=hunter2#frag-token ok')).toBe(
      'connect failed https://db.example.com:5432/x?[redacted] ok',
    )
    expect(redactUrls('postgres://u:dsn-pw@h/db')).toBe('postgres://h/db')
    expect(redactUrls('see https://example.com/hooks/abc#frag-token.')).toBe(
      'see https://example.com/hooks/abc#[redacted]',
    )
    expect(redactUrls('a@b in https://u:p@ss@host?x=1')).toBe('a@b in https://host?[redacted]')
  })

  test('an apostrophe in the userinfo does not end the URL, a quote around it does', () => {
    expect(redactUrls("https://user:sec'ret@host/p")).toBe('https://host/p')
    expect(redactUrls("see 'https://h/x?a=b' now")).toBe("see 'https://h/x?[redacted]' now")
  })

  test('a path segment that looks like a secret goes, a name stays', () => {
    expect(
      redactUrls('post to https://hooks.slack.com/services/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3 failed'),
    ).toBe('post to https://hooks.slack.com/services/T0123ABCD/B0123ABCD/[redacted] failed')
    expect(redactUrls('https://example.com/api/v1/forecast-service/health')).toBe(
      'https://example.com/api/v1/forecast-service/health',
    )
  })

  test('text with no URL is left alone, and the result is stable', () => {
    for (const text of ['no url here', 'user@host:22', 'ratio 1/2 ? # @', 'http:/not-a-url']) {
      expect(redactUrls(text)).toBe(text)
    }
    const once = redactUrls('x https://a:b@c/d?e=f#g y')
    expect(redactUrls(once)).toBe(once)
  })

  test('a long run of URL-like text costs nothing', () => {
    const started = performance.now()
    redactUrls(`${'a://'.repeat(15_000)}${'?'.repeat(5000)}`)
    redactUrls(`http://${'@'.repeat(60_000)}`)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('userinfo alone, for a link whose query is the search', () => {
    expect(withoutUserinfo('https://u:p@hyperdx.example.com/search?q=level%3Aerror')).toBe(
      'https://hyperdx.example.com/search?q=level%3Aerror',
    )
  })
})

describe('what leaves a parser', () => {
  const leaks = (value: unknown): string[] => SECRETS.filter((secret) => JSON.stringify(value).includes(secret))

  test('Kuma: the message, the heartbeat message, the title and the name', async () => {
    const base = (await fixture('kuma-down.json')) as { heartbeat: object; monitor: object }
    const msg = 'connect https://svc:s3cret@db.example.com/x?password=hunter2#frag-token and postgres://u:dsn-pw@h/db'
    const parsed = parseKuma({
      ...base,
      msg,
      monitor: { ...base.monitor, name: 'api https://u:s3cret@h/p?k=hunter2' },
      heartbeat: { ...base.heartbeat, msg },
    })
    if (parsed.kind !== 'alert') throw new Error('expected an alert')
    expect(leaks(parsed.alert)).toEqual([])
    expect(parsed.alert.title).toContain('db.example.com/x?[redacted]')
    expect(parsed.alert.monitor).toBe('api https://h/p?[redacted]')
  })

  test('HyperDX: the title, the body; a link loses its userinfo and keeps its search', async () => {
    const base = (await fixture('hyperdx-alert.json')) as object
    const parsed = parseHyperdx({
      ...base,
      title: '🚨 Alert for "calls https://x:s3cret@api.example.com/v1?key=hook-key" - 4 lines found',
      body: 'failed: https://api.example.com/v1?key=hook-key&t=hunter2',
      link: 'https://u:s3cret@hyperdx.example.com/search?q=level%3Aerror',
    })
    if (parsed.kind !== 'alert') throw new Error('expected an alert')
    expect(leaks(parsed.alert)).toEqual([])
    expect(parsed.alert.monitor).toBe('calls https://api.example.com/v1?[redacted]')
    expect(parsed.alert.facts).toMatchObject({ link: 'https://hyperdx.example.com/search?q=level%3Aerror' })
  })

  test('the short fields of both sources are redacted too, and a link loses its fragment', async () => {
    const base = (await fixture('kuma-down.json')) as { heartbeat: object; monitor: object }
    const kuma = parseKuma({
      ...base,
      monitor: { ...base.monitor, hostname: 'https://u:s3cret@host?k=hunter2', type: 'http://x:s3cret@y' },
    })
    const hyper = parseHyperdx({
      ...((await fixture('hyperdx-alert.json')) as object),
      alertId: 'https://u:s3cret@h/p?k=hunter2',
      link: 'https://hyperdx.example.com/search?q=x#frag-token',
    })
    if (kuma.kind !== 'alert' || hyper.kind !== 'alert') throw new Error('expected alerts')
    expect(leaks(kuma.alert)).toEqual([])
    expect(leaks(hyper.alert)).toEqual([])
    expect(hyper.alert.facts).toMatchObject({ link: 'https://hyperdx.example.com/search?q=x' })
  })
})
