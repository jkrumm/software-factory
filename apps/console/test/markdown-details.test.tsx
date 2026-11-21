import { describe, expect, test } from 'bun:test'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderToStaticMarkup } from 'react-dom/server'
import { remarkDetails } from '../src/lib/markdown-details.ts'

const html = (source: string) =>
  renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, remarkDetails]} skipHtml>
      {source}
    </Markdown>,
  )

describe('details in a Markdown artifact', () => {
  test('a details block renders closed, with its summary line first and its content inside', () => {
    const out = html(
      '## Build\n\nIt.\n\n<details>\n<summary>Why Postgres</summary>\n\nIt is already running.\n\n</details>\n\nAfter.',
    )
    expect(out).toContain('<details><summary>Why Postgres</summary><p>It is already running.</p></details>')
    expect(out).not.toContain('open')
    expect(out.indexOf('<h2>Build</h2>')).toBeLessThan(out.indexOf('<details>'))
    expect(out.indexOf('</details>')).toBeLessThan(out.indexOf('<p>After.</p>'))
  })

  test('a one-line opening, a closing tag with no blank line before it, and nested blocks', () => {
    const out = html(
      '<details><summary>Outer</summary>\n\nText\n</details>\n\n<details><summary>A</summary>\n\n<details><summary>B</summary>\n\nDeep.\n\n</details>\n\n</details>',
    )
    expect(out).toContain('<details><summary>Outer</summary><p>Text</p></details>')
    expect(out).toContain('<details><summary>A</summary><details><summary>B</summary><p>Deep.</p></details></details>')
  })

  test('open is kept, a block left open closes at the end, and other raw HTML is still dropped', () => {
    expect(html('<details open><summary>S</summary>\n\nBody.')).toContain(
      '<details open=""><summary>S</summary><p>Body.</p></details>',
    )
    expect(html('<script>alert(1)</script>\n\n<div>x</div>\n\nText')).not.toContain('<script')
  })
})
