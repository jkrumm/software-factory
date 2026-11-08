/**
 * The rule behind `no-raw-colour.test.ts`: colour comes from Basalt's tokens (`tokens.css`, `--vx-*`), never a literal.
 * `rawColours(source)` returns every literal colour in a source text, comments aside.
 */

const NAMED = [
  'white',
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'silver',
  'gold',
  'navy',
  'teal',
  'lime',
  'aqua',
  'cyan',
  'magenta',
  'maroon',
  'olive',
  'fuchsia',
  'brown',
  'tan',
  'beige',
  'ivory',
  'coral',
  'salmon',
  'crimson',
  'indigo',
  'violet',
].join('|')

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black'
const UTILITY = 'bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|accent|caret|decoration|placeholder'

const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![A-Za-z0-9-])/g
const FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g
const COLOR_MIX = /(?<![\w-])color-mix\(/g
/** A colour name used as a value: after `:`, `=`, `(`, `,` or `[`, or alone before `;` or `}`. */
const NAMED_VALUE = new RegExp(
  `(?:[\\[:=(,]\\s*['"]?(?:${NAMED})['"]?\\s*(?=[;,)}!'"\\]]|$)|\\s(?:${NAMED})\\s*(?=[;}]))`,
  'gm',
)
const PALETTE_UTILITY = new RegExp(
  `(?<![\\w-])(?:[a-z0-9-]+:)*(?:${UTILITY})-(?:${PALETTE})(?:-\\d+)?(?:\\/[\\w.%\\[\\]]+)?(?![\\w-])`,
  'g',
)

/** Drops comments; a `//` after a `:` or a quote is a URL, not a comment. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return text.length
}

const matches = (pattern: RegExp, text: string): string[] => [...text.matchAll(pattern)].map((m) => m[0].trim())

/** A `color-mix(...)` is raw when one of its arguments is a literal colour; `var()` and `transparent` arguments are fine. */
function rawColorMixes(code: string): string[] {
  const found: string[] = []
  for (const match of code.matchAll(COLOR_MIX)) {
    const open = match.index + match[0].length - 1
    const call = code.slice(match.index, closingParen(code, open) + 1)
    if (literals(call.slice(match[0].length)).length > 0) found.push(call)
  }
  return found
}

function literals(code: string): string[] {
  return [
    ...matches(HEX, code),
    ...matches(FUNCTION, code),
    ...matches(NAMED_VALUE, code),
    ...matches(PALETTE_UTILITY, code),
  ]
}

export function rawColours(source: string): string[] {
  const code = stripComments(source)
  return [...literals(code), ...rawColorMixes(code)]
}
