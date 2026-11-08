import { describe, expect, test } from 'bun:test'
import { rawColours } from './raw-colour.ts'

describe('rawColours', () => {
  const clean = [
    'background: var(--vx-surface-bg);',
    '--color-scrim: color-mix(in srgb, var(--vx-surface-bg) 70%, transparent);',
    'className="bg-background text-muted-foreground border-border ring-ring/50 bg-primary/80"',
    'fill: currentColor; stroke: inherit; border-color: transparent;',
    "const color = theme === 'dark' ? 'Dark' : 'Light'",
    'hover:bg-secondary/80 dark:bg-input/30 shadow-[inset_3px_0_0_var(--color-primary)]',
    '// a comment may say #fff, rgb(0 0 0) or bg-red-500\nconst a = 1 /* and white too */',
    "const url = 'https://example.com/#ref'",
    'ring-offset-background text-destructive bg-good',
  ]
  for (const sample of clean) test(`accepts ${sample.slice(0, 50)}`, () => expect(rawColours(sample)).toEqual([]))

  const dirty = [
    'color: #fff;',
    'color: #ffffff;',
    'color: #ffffff80;',
    'background: rgb(0 0 0)',
    'background: rgba(0, 0, 0, 0.5)',
    'color: hsl(210 20% 90%)',
    'color: hsla(210, 20%, 90%, 1)',
    'color: hwb(1 2% 3%)',
    'color: lab(50% 0 0)',
    'color: lch(50% 0 0)',
    'color: oklab(0.5 0 0)',
    'color: oklch(0.5 0 0)',
    'color: color(display-p3 1 0 0)',
    'background: color-mix(in srgb, #000 10%, transparent)',
    'bg-[color-mix(in_oklch,var(--secondary),#fff_5%)]',
    'color: white;',
    'border: 1px solid red;',
    "fill: 'black'",
    '<path fill="white" />',
    'bg-red-500',
    'text-gray-400',
    'border-white',
    'from-black/50',
    'ring-blue-600',
    'fill-slate-200',
    'dark:hover:bg-zinc-900',
    'bg-[#123]',
    'text-[rgb(1,2,3)]',
    'bg-[red]',
  ]
  for (const sample of dirty)
    test(`rejects ${sample.slice(0, 50)}`, () => expect(rawColours(sample).length).toBeGreaterThan(0))
})
