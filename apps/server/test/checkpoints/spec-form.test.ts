import { describe, expect, test } from 'bun:test'
import { SPEC_VISIBLE_MAX } from '@software-factory/contract'
import { specFormRefusal, specVisibleLength } from '../../src/domains/checkpoints/spec-form.ts'

const sections = '## Build\n\nA queue in Postgres.\n\n## Decided\n\nPostgres: it is already running.\n'
const filler = (n: number) => 'x'.repeat(n)

describe('the count of a Spec', () => {
  test('counts the text a reader meets, and leaves out details, fences and images', () => {
    const open = specVisibleLength(`# T\n\n${sections}`, 'markdown')
    const hidden = [
      '<details>',
      '<summary>Why Postgres</summary>',
      '',
      filler(5000),
      '',
      '<details><summary>inner</summary>',
      filler(500),
      '</details>',
      '</details>',
      '',
      '```ts',
      filler(5000),
      '```',
      '',
      '![a picture with a long alt text](https://images.example.com/a.png)',
    ].join('\n')
    expect(open).not.toBeNull()
    // the picture is left out whole; the rest of the text is the same
    expect(specVisibleLength(`# T\n\n${sections}\n${hidden}`, 'markdown')).toBe(open)
  })

  test('a visible paragraph counts, link targets do not', () => {
    const plain = specVisibleLength('A [link](https://example.com/\u0061\u0062\u0063) here.', 'markdown')
    expect(plain).toBe('A link here.'.length)
  })

  test('an HTML Spec counts its visible text outside details, svg and pre', () => {
    const html = `<!doctype html><html><head><title>${filler(900)}</title><style>p{color:red}</style></head><body>
      <h1>Cache</h1><p>Ten seconds.</p>
      <details><summary>More</summary><p>${filler(6000)}</p></details>
      <svg><text>${filler(900)}</text></svg><pre>${filler(900)}</pre></body></html>`
    expect(specVisibleLength(html, 'html')).toBe('Cache Ten seconds.'.length)
  })

  test('details tags that do not pair up count as nothing', () => {
    expect(specVisibleLength('<details><summary>x</summary>never closed', 'markdown')).toBeNull()
    expect(specVisibleLength('</details>', 'markdown')).toBeNull()
  })
})

describe('the form of a Spec', () => {
  test('a Spec with Build and Decided that fits a page is accepted', () => {
    expect(specFormRefusal(`# Queue\n\n${sections}`, 'markdown')).toBeNull()
    expect(specFormRefusal(sections, 'markdown')).toBeNull()
  })

  test('a Spec without the two sections is refused and names what it opens with', () => {
    const refusal = specFormRefusal('# Queue\n\n## Context\n\nWords.\n\n## Options\n\nMore words.', 'markdown')
    expect(refusal).toContain('## Build')
    expect(refusal).toContain('## Decided')
    expect(refusal).toContain('context, options')
    expect(specFormRefusal('Words only.', 'markdown')).toContain('no heading')
    expect(specFormRefusal('## Build\n\nIt.', 'markdown')).toContain('## Decided')
    expect(specFormRefusal('## Decided\n\nIt.\n\n## Build\n\nIt.', 'markdown')).toContain('## Build')
  })

  test('sections inside a details block or a fence do not count as the sections', () => {
    const hidden = '# T\n\n<details><summary>x</summary>\n\n## Build\n\nIt.\n\n## Decided\n\nIt.\n\n</details>'
    expect(specFormRefusal(hidden, 'markdown')).toContain('## Build')
    expect(specFormRefusal('# T\n\n```md\n## Build\n## Decided\n```', 'markdown')).toContain('## Build')
  })

  test('the Build section holds at most eight lines', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `- line ${i}`).join('\n')
    const eight = Array.from({ length: 8 }, (_, i) => `- line ${i}`).join('\n')
    expect(specFormRefusal(`## Build\n\n${nine}\n\n## Decided\n\nIt.`, 'markdown')).toContain('9 lines')
    expect(specFormRefusal(`## Build\n\n${eight}\n\n## Decided\n\nIt.`, 'markdown')).toBeNull()
  })

  test('a Spec over the limit is refused with the count and both ways out', () => {
    const refusal = specFormRefusal(`${sections}\n${filler(SPEC_VISIBLE_MAX)}`, 'markdown')
    const text = `${sections}\n${filler(SPEC_VISIBLE_MAX)}`
    expect(refusal).toContain(`${specVisibleLength(text, 'markdown')} characters`)
    expect(refusal).toContain(`at most ${SPEC_VISIBLE_MAX}`)
    expect(refusal).toContain('<details>')
    expect(refusal).toContain('Report')
    expect(refusal).toContain('factory artifact new')
  })

  test('the same detail inside a details block fits', () => {
    const detail = `<details><summary>Why</summary>\n\n${filler(20000)}\n\n</details>`
    expect(specFormRefusal(`${sections}\n${detail}`, 'markdown')).toBeNull()
  })

  test('an HTML Spec is held to the count, with no sections required', () => {
    const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
    expect(specFormRefusal(page(`<p>${filler(100)}</p>`), 'html')).toBeNull()
    expect(specFormRefusal(page(`<p>${filler(SPEC_VISIBLE_MAX + 1)}</p>`), 'html')).toContain(
      `at most ${SPEC_VISIBLE_MAX}`,
    )
    expect(specFormRefusal(page(`<details><summary>s</summary><p>${filler(9000)}</p></details>`), 'html')).toBeNull()
  })

  test('an unclosed details block is refused rather than hiding the rest', () => {
    expect(specFormRefusal(`${sections}\n<details><summary>x</summary>${filler(9000)}`, 'markdown')).toContain(
      'not closed',
    )
  })
})
