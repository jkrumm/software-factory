import { describe, expect, test } from 'bun:test'
import { aboutLine, artifactPreview, plainExcerpt, plainLine, signalParts, sourceLabel } from '../src/lib/plain.ts'

describe('signalParts', () => {
  test('splits ISO times out and drops env names, issue ids and the machine command', () => {
    const text =
      'lead-539-1 on issue_539 is idle since 2026-11-09T11:30:23.973Z (FACTORY_STEWARD_IDLE_MS). Reproduce: factory issue show issue_539'
    expect(signalParts(text)).toEqual([
      { kind: 'text', text: 'the lead on an Issue is idle since ' },
      { kind: 'time', iso: '2026-11-09T11:30:23.973Z' },
      { kind: 'text', text: '.' },
    ])
  })

  test('reads the title the server wrote digits into', () => {
    expect(signalParts("Self-watch: lead lead- five three nine - one idle past the steward's threshold")).toEqual([
      { kind: 'text', text: "Self-watch: the lead idle past the steward's threshold" },
    ])
  })

  test('removes artifact ids and uuids and collapses whitespace', () => {
    const [part] = signalParts('see artifact_0f8e1c2a-1111-4222-8333-444455556666   now')
    expect(part).toEqual({ kind: 'text', text: 'see now' })
  })

  test('plain text stays one part', () => {
    expect(signalParts('It also needs a last run time.')).toEqual([
      { kind: 'text', text: 'It also needs a last run time.' },
    ])
    expect(signalParts('')).toEqual([])
  })
})

describe('sourceLabel', () => {
  test('says an agent in words', () => {
    expect(sourceLabel('agent:software-factory')).toBe('Agent in software-factory')
    expect(sourceLabel('owner:hermes')).toBe('hermes')
    expect(sourceLabel('github')).toBe('github')
    expect(sourceLabel('feedback:a b:c')).toBe('feedback:a b:c')
    expect(sourceLabel('  ')).toBeNull()
  })
})

describe('aboutLine', () => {
  test('rejects a fragment cut from a timestamp', () => {
    const cut = '482Z Idle for 24 min Reproduce: factory issue show an Issue; factory read overview'
    expect(aboutLine(cut, 'Title', 'Filed')).toBeNull()
  })

  test('accepts a clean sentence and rejects repeats and machine text', () => {
    const clean = 'Console v1: every screen reads the API and shows words, not ids.'
    expect(aboutLine(clean, 'Title', 'Filed')).toBe(clean)
    expect(aboutLine(clean, clean, 'Filed')).toBeNull()
    expect(aboutLine(null, 'Title', 'Filed')).toBeNull()
    expect(aboutLine('Set FACTORY_STEWARD_IDLE_MS to tune it.', 'T', 'F')).toBeNull()
    expect(aboutLine('Look at issue_12 again.', 'T', 'F')).toBeNull()
    expect(aboutLine('It stops at 2026-11-09T11:30 sharp.', 'T', 'F')).toBeNull()
    expect(aboutLine('no capital and no end', 'T', 'F')).toBeNull()
  })
})

describe('artifactPreview', () => {
  const page = (body: string) =>
    `<!doctype html><html><head><title>x</title><style>p{color:red}</style></head><body>${body}</body></html>`

  test('html: the TLDR callout, a tldr element, or nothing', () => {
    const callout = page(
      '<h1>T</h1><div class="callout"><div class="callout-title">TLDR</div><p>We keep it &amp; ship <b>today</b>.</p></div>',
    )
    expect(artifactPreview('html', callout)).toBe('We keep it & ship today.')
    const named = page('<section id="tldr"><p>Short <em>version</em>.</p></section><p>Other</p>')
    expect(artifactPreview('html', named)).toBe('Short version.')
    expect(artifactPreview('html', page('<h1>T</h1><p>No summary here.</p><script>var TLDR=1</script>'))).toBeNull()
  })

  test('markdown: the TLDR section, else the first paragraph, plain and cut', () => {
    expect(artifactPreview('markdown', '# Queue\n\nWe keep the **queue** in [Postgres](http://x).\n\nMore.')).toBe(
      'We keep the queue in Postgres.',
    )
    expect(artifactPreview('markdown', '# Q\n\nIntro.\n\n## TLDR\n\n- Ship `it`\n- Today\n\n## Next\n\nZ')).toBe(
      'Ship it Today',
    )
    expect(artifactPreview('markdown', '# Only a heading')).toBeNull()
    const long = artifactPreview('markdown', `# T\n\n${'word '.repeat(200)}`)
    expect(long?.endsWith('…')).toBe(true)
    expect(long?.length).toBeLessThanOrEqual(401)
  })
})

describe('plainExcerpt', () => {
  test('removes fences and markdown syntax but keeps the content', () => {
    const text =
      '## Error\n\nIt said:\n\n```ts\nthrow new Error("x")\n```\n\n\n\n- see **this** and [the docs](http://x) `now`'
    expect(plainExcerpt(text)).toBe('Error\n\nIt said:\n\nthrow new Error("x")\n\nsee this and the docs now')
    expect(plainExcerpt(text)).not.toContain('```')
  })
})

describe('plainLine', () => {
  test('a timeline line has no spelled-out lead id and no ISO time', () => {
    const line = plainLine(
      "Self-watch: lead lead- five three nine - one idle since 2026-11-09T11:30:23.973Z past the steward's threshold",
    )
    expect(line).not.toContain('lead lead-')
    expect(line).not.toMatch(/\d{4}-\d\d-\d\dT/)
    expect(line).not.toContain('- one')
    expect(line).toStartWith('Self-watch: the lead idle since ')
  })
})
