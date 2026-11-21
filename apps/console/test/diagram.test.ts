import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { figureOf } from '../scripts/diagram.ts'

const FLOW = 'flowchart LR\n A[Signal] --> B{Triage}\n B -- Issue --> C[Lead]\n C --> D[Ship]\n'

describe('scripts/diagram.ts', () => {
  test('a Mermaid flowchart becomes a figure with the caption as its name and its figcaption', () => {
    const figure = figureOf(FLOW, 'Signal to ship')
    expect(figure.startsWith('<figure>\n<svg aria-label="Signal to ship" ')).toBe(true)
    expect(figure.endsWith('<figcaption>Signal to ship</figcaption>\n</figure>\n')).toBe(true)
    for (const word of ['Signal', 'Triage', 'Lead', 'Ship']) expect(figure).toContain(word)
  })

  test('draws with the Pele variables the template maps, and holds no script, namespace or link', () => {
    const figure = figureOf(FLOW, 'x')
    expect(figure).toMatch(/^<figure>\n<svg [^>]*class="pele /)
    expect(figure).toContain('var(--pele-bg')
    expect(figure).not.toMatch(/<script|on\w+=|https?:|xmlns/i)
  })

  test('a caption with markup is escaped', () => {
    const figure = figureOf(FLOW, 'a "b" <i>')
    expect(figure).toContain('aria-label="a &quot;b&quot; &lt;i&gt;"')
    expect(figure).not.toContain('<i>')
  })

  test('--width scales the drawing and keeps its proportions', () => {
    const natural = /viewBox="0 0 ([\d.]+) ([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(figureOf(FLOW, 'x'))
    const scaled = /viewBox="0 0 [\d.]+ [\d.]+" width="([\d.]+)" height="([\d.]+)"/.exec(figureOf(FLOW, 'x', 960))
    expect(scaled?.[1]).toBe('960')
    expect(Number(scaled?.[2])).toBe(Math.round((Number(natural?.[4]) * 960) / Number(natural?.[3])))
  })

  test('a syntax error throws instead of printing a broken figure', () => {
    expect(() => figureOf('flowchart LR\nA-->', 'x')).toThrow()
  })
})

describe('the template and the diagrams', () => {
  const template = readFileSync(join(import.meta.dir, '../templates/artifact.html'), 'utf8')

  test('maps every Pele variable the figure uses to a token', () => {
    const used = new Set(
      figureOf(FLOW, 'x')
        .match(/var\((--pele-[\w-]+)/g)
        ?.map((v) => v.slice(4)),
    )
    const rule = /\.pele \{([^}]*)\}/.exec(template)?.[1] ?? ''
    for (const name of used) expect(rule).toContain(`${name}:`)
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  test('its example figure is wider than the text column, so it takes the pane', () => {
    const width = Number(/<figure>\s*<svg viewBox="0 0 (\d+) /.exec(template)?.[1])
    expect(width).toBeGreaterThanOrEqual(800)
  })

  test('says diagrams are figures and names the script', () => {
    expect(template).toContain('never ASCII art')
    expect(template).toContain('scripts/diagram.ts')
  })
})
