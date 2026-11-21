import { describe, expect, test } from 'bun:test'
import { picturesRefusal, unloadedPictures } from '../../src/domains/checkpoints/pictures.ts'

const NOW = new Date('2026-11-21T10:00:00Z')
const HOSTS = ['s3.eu-central-003.backblazeb2.com', '*.cdn.example.com']
const presigned = (date: string, expires = 604800) =>
  `https://s3.eu-central-003.backblazeb2.com/b/x.png?X-Amz-Date=${date}&X-Amz-Expires=${expires}`

describe('unloadedPictures (markdown)', () => {
  test('a picture from a listed host loads, an unlisted one does not', () => {
    expect(unloadedPictures(`![a](${presigned('20261120T100000Z')})`, 'markdown', HOSTS, NOW)).toEqual([])
    const found = unloadedPictures('![shot](https://raw.githubusercontent.com/x/y.jpg)', 'markdown', HOSTS, NOW)
    expect(found).toHaveLength(1)
    expect(found[0]?.label).toBe('shot')
    expect(found[0]?.reason).toContain('raw.githubusercontent.com')
  })

  test('a wildcard host matches a subdomain only, and the port must be the default', () => {
    expect(unloadedPictures('![a](https://img.cdn.example.com/a.png)', 'markdown', HOSTS, NOW)).toEqual([])
    expect(unloadedPictures('![a](https://cdn.example.com/a.png)', 'markdown', HOSTS, NOW)).toHaveLength(1)
    expect(unloadedPictures('![a](https://img.cdn.example.com:8443/a.png)', 'markdown', HOSTS, NOW)).toHaveLength(1)
  })

  test('http, relative and data links do not load', () => {
    const content = '![a](http://img.cdn.example.com/a.png) ![b](/a.png) ![c](data:image/png;base64,AAAA)'
    expect(unloadedPictures(content, 'markdown', HOSTS, NOW)).toHaveLength(3)
  })

  test('an expired presigned link does not load', () => {
    const found = unloadedPictures(`![old](${presigned('20261101T100000Z')})`, 'markdown', HOSTS, NOW)
    expect(found[0]?.reason).toContain('expired')
  })

  test('with no host listed every https picture is refused; code blocks are not pictures', () => {
    expect(unloadedPictures('![a](https://x.example.com/a.png)', 'markdown', [], NOW)[0]?.reason).toContain(
      'none is listed',
    )
    const code = '```md\nfirst\n![a](https://x.example.com/a.png)\n```\n`![b](https://x.example.com/b.png)`'
    expect(unloadedPictures(code, 'markdown', HOSTS, NOW)).toEqual([])
    const nested =
      '````md\n```md\n![a](https://x.example.com/a.png)\n```\n````\n```\n~~~\n![b](https://x.example.com/b.png)\n~~~\n```'
    expect(unloadedPictures(nested, 'markdown', HOSTS, NOW)).toEqual([])
    const crlf = '```md\r\n![a](https://x.example.com/a.png)\r\n```\r\n![c](https://x.example.com/c.png)'
    expect(unloadedPictures(crlf, 'markdown', HOSTS, NOW)).toHaveLength(1)
    const after = '```\nx\ny\n```\n![c](https://x.example.com/c.png)'
    expect(unloadedPictures(after, 'markdown', HOSTS, NOW)).toHaveLength(1)
  })
})

describe('unloadedPictures (html)', () => {
  test('only data: pictures show in the frame', () => {
    expect(unloadedPictures('<img src="data:image/png;base64,AAAA" alt="a">', 'html', [], NOW)).toEqual([])
    expect(unloadedPictures(`<img alt="a" src='https://example.com/a.png'>`, 'html', HOSTS, NOW)).toHaveLength(1)
  })
})

describe('picturesRefusal', () => {
  test('names each picture and the way out; null when all load', () => {
    expect(picturesRefusal('no pictures', 'markdown', HOSTS, NOW)).toBeNull()
    const text = picturesRefusal('![shot](https://raw.githubusercontent.com/x.jpg)', 'markdown', HOSTS, NOW)
    expect(text).toContain('1 picture would not show')
    expect(text).toContain('"shot"')
    expect(text).toContain('imgcli private')
  })
})
