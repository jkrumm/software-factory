#!/usr/bin/env bun
/**
 * Mermaid text to a `<figure>` for an HTML artifact: Pele (a Mermaid renderer that themes by CSS variables) draws the SVG and
 * the template's `.pele` rule maps its variables to the Basalt tokens, so the figure follows the Console's light and dark
 * theme and leaves the text column for the pane when it is wider than it (see `templates/artifact.html`).
 *
 *   bun apps/console/scripts/diagram.ts <file.mmd | -> --caption "What the picture shows" [--width 960] > figure.html
 *
 * Paste the output where the figure goes, inside `<main>`. Every Mermaid diagram type Pele supports works (flowchart,
 * sequence, state, class, ER, gantt, ...). `--width` scales the drawing (text with it) to that many pixels, 480 to 1600: a
 * narrow diagram then takes the pane like a wide one. A syntax error exits 1 with Pele's message; nothing is printed then.
 */
import { readFileSync } from 'node:fs'
import { render } from 'pele'

const MIN_WIDTH = 480
const MAX_WIDTH = 1600

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The figure for one diagram: the themed SVG, named for a screen reader by the caption, and the caption under it. */
export function figureOf(mermaid: string, caption: string, width?: number): string {
  const label = escapeHtml(caption)
  // an inline svg needs no namespace, and the artifact template holds no http(s) text
  let svg = render(mermaid)
    .svg.replace(/^<svg xmlns="[^"]*"/, '<svg')
    .replace(/^<svg/, `<svg aria-label="${label}"`)
  if (width !== undefined) {
    const natural = Number(/^<svg[^>]*? width="([\d.]+)" height="([\d.]+)"/.exec(svg)?.[1])
    const height = Number(/^<svg[^>]*? width="[\d.]+" height="([\d.]+)"/.exec(svg)?.[1])
    if (natural > 0 && height > 0) {
      const scaled = Math.round((height * width) / natural)
      svg = svg.replace(/^(<svg[^>]*?) width="[\d.]+" height="[\d.]+"/, `$1 width="${width}" height="${scaled}"`)
    }
  }
  return `<figure>\n${svg}\n<figcaption>${label}</figcaption>\n</figure>\n`
}

const USAGE =
  'usage: bun apps/console/scripts/diagram.ts <file.mmd | -> --caption "What the picture shows" [--width 960]'

function option(argv: string[], name: string): { value: string | undefined; rest: string[] } {
  const at = argv.indexOf(name)
  if (at === -1) return { value: undefined, rest: argv }
  return { value: argv[at + 1], rest: argv.filter((_, i) => i !== at && i !== at + 1) }
}

function main(args: string[]): number {
  const withCaption = option(args, '--caption')
  const withWidth = option(withCaption.rest, '--width')
  const source = withWidth.rest[0]
  const width = withWidth.value === undefined ? undefined : Number(withWidth.value)
  if (!source || !withCaption.value) {
    console.error(USAGE)
    return 2
  }
  if (width !== undefined && !(width >= MIN_WIDTH && width <= MAX_WIDTH)) {
    console.error(`--width is ${MIN_WIDTH} to ${MAX_WIDTH} pixels`)
    return 2
  }
  try {
    process.stdout.write(figureOf(readFileSync(source === '-' ? 0 : source, 'utf8'), withCaption.value, width))
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
