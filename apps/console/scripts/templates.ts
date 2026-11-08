#!/usr/bin/env bun
/**
 * Keeps the token block of `templates/artifact.html` in step with `src/styles/tokens.css`. The template is hand-written
 * around two markers (oxfmt may re-indent them; the block follows); what sits between them is generated: the Basalt tokens the template uses, the light values as the
 * default and the dark values under `prefers-color-scheme: dark`.
 *
 *   bun scripts/templates.ts            rewrite the block
 *   bun scripts/templates.ts --check    exit 1 when the file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const TOKENS = join(root, 'src/styles/tokens.css')
const TEMPLATE = join(root, 'templates/artifact.html')

const BEGIN = '/* tokens:begin - generated from src/styles/tokens.css by scripts/templates.ts; do not edit */'
const END = '/* tokens:end */'

/** The tokens the template's rules use. A name missing from tokens.css fails the script. */
export const USED = [
  '--vx-surface-bg',
  '--vx-surface-panel',
  '--vx-surface-subtle',
  '--vx-surface-border',
  '--vx-ink',
  '--vx-ink2',
  '--vx-faint',
  '--vx-accent',
  '--vx-accent-fill',
  '--vx-on-accent',
  '--vx-good-solid',
  '--vx-warn-solid',
  '--vx-bad-solid',
  '--vx-good-soft',
  '--vx-warn',
  '--vx-bad',
  '--vx-radius-card',
  '--vx-radius-ctrl',
  '--vx-radius-fine',
  '--vx-prose-measure',
  '--vx-space-stack-sm',
  '--vx-space-stack-md',
  '--vx-space-stack-lg',
  '--vx-space-stack-xl',
] as const

/** The declarations of the first rule that starts with `selector {`. */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`tokens.css has no rule ${selector}: run \`bun run tokens\``)
  const body = css.slice(start, css.indexOf('\n}', start))
  return new Map([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]))
}

const pick = (from: Map<string, string>): string[] => USED.map((name) => `${name}: ${from.get(name)};`)

export function tokenBlock(css: string): string {
  const base = declarations(css, ':root')
  const light = new Map([...base, ...declarations(css, ":root[data-theme='light']")])
  const dark = new Map([...base, ...declarations(css, ":root,\n:root[data-theme='dark']")])
  const missing = USED.filter((name) => !light.has(name) || !dark.has(name))
  if (missing.length > 0) throw new Error(`tokens.css lacks ${missing.join(', ')}`)
  const indent = (lines: string[], by: string) => lines.map((line) => `${by}${line}`).join('\n')
  return [
    BEGIN,
    ':root {',
    indent(pick(light), '  '),
    '  color-scheme: light dark;',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    indent(pick(dark), '    '),
    '  }',
    '}',
    END,
  ].join('\n')
}

/** The template with its block replaced, indented as the markers are (oxfmt indents the contents of `<style>`). */
export function withBlock(template: string, block: string): string {
  const from = template.indexOf(BEGIN)
  const to = template.indexOf(END)
  if (from === -1 || to === -1 || to < from) throw new Error('artifact.html lost its tokens:begin / tokens:end markers')
  const indent = /[ \t]*$/.exec(template.slice(0, from))?.[0] ?? ''
  const lines = block.split('\n').map((line, i) => (i === 0 ? line : `${indent}${line}`))
  return template.slice(0, from) + lines.join('\n') + template.slice(to + END.length)
}

if (import.meta.main) {
  const current = readFileSync(TEMPLATE, 'utf8')
  const next = withBlock(current, tokenBlock(readFileSync(TOKENS, 'utf8')))
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('templates/artifact.html is stale: run `bun run --cwd apps/console templates`')
      process.exit(1)
    }
  } else {
    writeFileSync(TEMPLATE, next)
  }
}
