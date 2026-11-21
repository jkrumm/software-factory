import { expect, test } from 'bun:test'
import { specHead, specHeadText } from '../src/index.ts'

const SPEC = [
  '# Panel',
  '',
  '## Build',
  '',
  'A closed panel.',
  '',
  '### A detail under Build',
  '',
  'Still Build.',
  '',
  '## Decided',
  '',
  '- It stays closed.',
  '',
  '```',
  '## Decided inside a fence',
  '```',
  '',
  '## Detail',
  '',
  'The long tail.',
].join('\n')

test('the head is the Build and Decided sections, up to the next heading of their level', () => {
  const head = specHead(SPEC)
  expect(head.build).toContain('A closed panel.')
  expect(head.build).toContain('Still Build.')
  expect(head.decided).toBe('- It stays closed.\n\n```\n## Decided inside a fence\n```')
  expect(specHeadText(SPEC)).not.toContain('The long tail.')
  expect(specHeadText(SPEC).startsWith('## Build')).toBe(true)
})

test('a Spec with neither section gives its first part', () => {
  expect(specHead('# T\n\nJust prose.')).toEqual({ build: null, decided: null })
  expect(specHeadText('# T\n\nJust prose.')).toBe('# T\n\nJust prose.')
  expect(specHeadText('x'.repeat(9000))).toHaveLength(4000)
})

test('an HTML Spec gives its Build and Decided as text, not its template', () => {
  const html = [
    '<!doctype html><html><head><style>:root { --vx-ink: #000 }</style></head><body><main>',
    '<!-- the artifact template -->',
    '<h1>Panel</h1><h2>Build</h2><p>A closed &amp; quiet panel.</p><ul><li>One</li><li>Two</li></ul>',
    '<h2>Decided</h2><p>It stays closed.</p><h2>Detail</h2><p>The long tail.</p></main></body></html>',
  ].join('\n')
  const head = specHead(html)
  expect(head.build).toBe('A closed & quiet panel.\n\n- One\n- Two')
  expect(head.decided).toBe('It stays closed.')
  expect(specHeadText(html)).not.toContain('vx-ink')
  expect(specHeadText(html)).not.toContain('The long tail.')
})
