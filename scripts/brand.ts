/**
 * Writes the Factory mark's SVGs from its parameters: `bun scripts/brand.ts`. The rasters are built from them
 * (docs/brand/README.md, "Rebuild the set").
 *
 * One arrow is a band round the centre that ends in a barbed head; the mark is that arrow twice, the second turned
 * 180 degrees. Each tail runs under the other arrow's head and is cut back by `gap`, so the two never touch.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARK = {
  /** Radius of the band's centre line and the band's width, in a 100-unit box. */
  radius: 28,
  band: 14,
  /** The head: how far its barbs reach outward and inward from the centre line, its length and sweep in degrees. */
  barbOut: 19,
  barbIn: 14,
  headLength: 40,
  sweepBack: 12,
  /** Where the tip sits: its radius, and how many degrees it runs past the other arrow's tail. */
  tipRadius: 40,
  overlap: 8,
  /** Angle of the tail in degrees, clockwise from three o'clock, and the clear space round a head. */
  tail: 190,
  gap: 4,
}
/** How much of the tile the mark fills, and the same inside a maskable icon's safe circle. */
export const TILE_SCALE = 0.97
export const MASKABLE_SCALE = 0.76

const num = (value: number) => String(Number(value.toFixed(2)))
const point = (radius: number, degrees: number) => {
  const angle = (degrees * Math.PI) / 180
  return `${num(50 + radius * Math.cos(angle))} ${num(50 + radius * Math.sin(angle))}`
}

function arrows(): string {
  const { radius, band, barbOut, barbIn, headLength, sweepBack, tipRadius, overlap, tail, gap } = MARK
  const tip = tail + 180 + overlap
  const base = tip - headLength
  const outer = radius + band / 2
  const inner = radius - band / 2
  const head = [
    point(outer, base),
    point(radius + barbOut, base - sweepBack),
    point(tipRadius, tip),
    point(radius - barbIn, base - sweepBack),
    point(inner, base),
  ]
  const body = `M${point(outer, tail)}A${outer} ${outer} 0 0 1 ${head.join('L')}A${inner} ${inner} 0 0 0 ${point(inner, tail)}Z`
  const turned = 'transform="rotate(180 50 50)"'
  return (
    '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/>' +
    `<path d="M${head.join('L')}Z" ${turned} stroke="#000" stroke-width="${2 * gap}" stroke-miterlimit="10"/></mask>` +
    `<g id="a" mask="url(#m)"><path d="${body}" fill="currentColor"/></g><use href="#a" ${turned}/>`
  )
}

/** The mark on its blue tile; `corner` 0 is the full-bleed copy the phone and the store round themselves. */
export function tile(scale = TILE_SCALE, corner = 22): string {
  const offset = num(50 - 50 * scale)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#5b88c4"/><stop offset="1" stop-color="#355d98"/></linearGradient></defs>' +
    `<rect width="100" height="100"${corner ? ` rx="${corner}"` : ''} fill="url(#t)"/>` +
    `<g style="color:#f2f3f5" transform="translate(${offset} ${offset}) scale(${scale})">${arrows()}</g></svg>\n`
  )
}

/** The bare mark, dark on light and light on dark. */
export function glyph(): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<style>svg{color:#16191c}@media (prefers-color-scheme:dark){svg{color:#f2f3f5}}</style>' +
    `${arrows()}</svg>\n`
  )
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const files: [string, string][] = [
    ['docs/brand/mark.svg', tile()],
    ['apps/console/public/icons/mark.svg', tile()],
    ['docs/brand/full-bleed.svg', tile(TILE_SCALE, 0)],
    ['docs/brand/maskable.svg', tile(MASKABLE_SCALE, 0)],
    ['docs/brand/glyph.svg', glyph()],
    ['apps/console/public/icons/glyph.svg', glyph()],
    ['docs/guide/public/glyph.svg', glyph()],
  ]
  for (const [path, svg] of files) writeFileSync(join(root, path), svg)
  console.log(files.map(([path]) => path).join('\n'))
}
