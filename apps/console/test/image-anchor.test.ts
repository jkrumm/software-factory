import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'bun:test'
import { type ImageRef, resolveImage, srcHash } from '@software-factory/contract'

/**
 * The picture resolver exists twice: in packages/contract/src/image-anchor.ts (the page and the server) and in
 * public/frame/lightbox.js (the HTML frame, plain JavaScript with no imports). One table of cases runs against both.
 */

type Hint = { occurrence: number; srcHash: string; label: string }
interface Resolver {
  srcHash: (src: string) => string
  resolveImage: (refs: readonly ImageRef[], hint: Hint) => number
}

const source = readFileSync(join(import.meta.dir, '../public/frame/lightbox.js'), 'utf8')
const block = source.slice(source.indexOf('// image:begin'), source.indexOf('// image:end'))
if (!block.includes('function resolveImage')) throw new Error('lightbox.js lost its image:begin / image:end block')
const inFrame = runInNewContext(`${block}; ({ srcHash, resolveImage })`) as Resolver

const ref = (hash: string, label = ''): ImageRef => ({ hash, label })
const shots = [ref('aaaaaaaa', 'Home'), ref('bbbbbbbb', 'Queue'), ref('cccccccc', 'Settings')]
const CASES: Array<{ name: string; refs: ImageRef[]; hint: Hint }> = [
  { name: 'in place', refs: shots, hint: { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' } },
  {
    name: 'reordered',
    refs: [shots[2], shots[0], shots[1]] as ImageRef[],
    hint: { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' },
  },
  {
    name: 'hash beats label',
    refs: [ref('bbbbbbbb', 'Other'), ref('aaaaaaaa', 'Queue')],
    hint: { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' },
  },
  {
    name: 'equal src, the label tells them apart',
    refs: [ref('aaaaaaaa', 'One'), ref('aaaaaaaa', 'Two'), ref('aaaaaaaa', 'One')],
    hint: { occurrence: 0, srcHash: 'aaaaaaaa', label: 'Two' },
  },
  {
    name: 'equal src and label, the nearest place',
    refs: [ref('aaaaaaaa', 'One'), ref('aaaaaaaa', 'One'), ref('aaaaaaaa', 'One')],
    hint: { occurrence: 2, srcHash: 'aaaaaaaa', label: 'One' },
  },
  {
    name: 'a new src, the same label',
    refs: [ref('11111111', 'Home'), ref('22222222', 'Queue')],
    hint: { occurrence: 5, srcHash: 'bbbbbbbb', label: 'Queue' },
  },
  {
    name: 'replaced',
    refs: [ref('11111111', 'Home'), ref('22222222', 'Brand new')],
    hint: { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' },
  },
  { name: 'no pictures', refs: [], hint: { occurrence: 0, srcHash: 'bbbbbbbb', label: 'Queue' } },
  {
    name: 'an uncaptioned svg by its place',
    refs: [ref(''), ref('aaaaaaaa', 'Home'), ref('')],
    hint: { occurrence: 2, srcHash: '', label: '' },
  },
  {
    name: 'an uncaptioned svg, another picture at its place',
    refs: [ref(''), ref('aaaaaaaa', 'Home'), ref('')],
    hint: { occurrence: 1, srcHash: '', label: '' },
  },
  {
    name: 'an uncaptioned svg, past the end',
    refs: [ref('')],
    hint: { occurrence: 4, srcHash: '', label: '' },
  },
]

describe('the picture resolver, in the contract and in the frame', () => {
  for (const { name, refs, hint } of CASES) {
    test(name, () => {
      expect(inFrame.resolveImage(JSON.parse(JSON.stringify(refs)), hint)).toBe(resolveImage(refs, hint))
    })
  }

  test('the copies hash a src alike', () => {
    for (const src of ['', 'a', 'https://x.test/a.png?x=1&y=2', 'data:image/png;base64,iVBORw0KGgo=', 'ünï/çødé 😀']) {
      expect(inFrame.srcHash(src)).toBe(srcHash(src))
    }
  })
})
