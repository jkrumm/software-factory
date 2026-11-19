import { describe, expect, test } from 'bun:test'
import { AnnotateBody, ArtifactDetail } from '../src/checkpoints.ts'
import { ImageAnchor, imageQuote, resolveImage, srcHash, type ImageRef } from '../src/image-anchor.ts'

const ref = (hash: string, label = ''): ImageRef => ({ hash, label })

describe('srcHash', () => {
  test('is eight hex digits, stable, and tells sources apart', () => {
    expect(srcHash('')).toBe('811c9dc5')
    expect(srcHash('a')).toBe('e40c292c')
    expect(srcHash('data:image/png;base64,AAAA')).toMatch(/^[0-9a-f]{8}$/)
    expect(srcHash('https://x.test/a.png')).not.toBe(srcHash('https://x.test/b.png'))
  })
})

describe('imageQuote', () => {
  test('names the picture, its label and the spot', () => {
    expect(imageQuote({ occurrence: 1, label: 'Settings page' })).toBe('Image 2: Settings page')
    expect(imageQuote({ occurrence: 0, label: '' })).toBe('Image 1')
    expect(imageQuote({ occurrence: 2, label: 'Queue', x: 0.424, y: 0.63 })).toBe('Image 3: Queue · spot 42% / 63%')
    expect(imageQuote({ occurrence: 2, label: 'Queue', x: null, y: null })).toBe('Image 3: Queue')
  })
})

describe('resolveImage', () => {
  const shots = [ref('aaaaaaaa', 'Home'), ref('bbbbbbbb', 'Queue'), ref('cccccccc', 'Settings')]

  test('a revision that reorders the pictures keeps each comment on its picture', () => {
    const reordered = [shots[2] as ImageRef, shots[0] as ImageRef, shots[1] as ImageRef]
    expect(resolveImage(reordered, { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' })).toBe(2)
    expect(resolveImage(reordered, { occurrence: 2, srcHash: 'cccccccc', label: 'Settings' })).toBe(0)
  })

  test('the src hash wins over the label and the place', () => {
    const swapped = [ref('bbbbbbbb', 'Other'), ref('aaaaaaaa', 'Queue')]
    expect(resolveImage(swapped, { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' })).toBe(0)
  })

  test('equal src: the same label, then the nearest place', () => {
    const twice = [ref('aaaaaaaa', 'One'), ref('aaaaaaaa', 'Two'), ref('aaaaaaaa', 'One')]
    expect(resolveImage(twice, { occurrence: 0, srcHash: 'aaaaaaaa', label: 'Two' })).toBe(1)
    expect(resolveImage(twice, { occurrence: 2, srcHash: 'aaaaaaaa', label: 'One' })).toBe(2)
    expect(resolveImage(twice, { occurrence: 1, srcHash: 'aaaaaaaa', label: 'Gone' })).toBe(1)
  })

  test('a changed src falls back to the label', () => {
    const rebuilt = [ref('11111111', 'Home'), ref('22222222', 'Queue')]
    expect(resolveImage(rebuilt, { occurrence: 5, srcHash: 'bbbbbbbb', label: 'Queue' })).toBe(1)
  })

  test('a picture replaced by another src and label is gone, not moved to the picture at its place', () => {
    const replaced = [ref('11111111', 'Home'), ref('22222222', 'Brand new')]
    expect(resolveImage(replaced, { occurrence: 1, srcHash: 'bbbbbbbb', label: 'Queue' })).toBe(-1)
    expect(resolveImage([], { occurrence: 0, srcHash: 'bbbbbbbb', label: 'Queue' })).toBe(-1)
  })

  test('only a picture with neither a src nor a label resolves by its place, and only onto one like it', () => {
    const svgs = [ref(''), ref('aaaaaaaa', 'Home'), ref('')]
    expect(resolveImage(svgs, { occurrence: 2, srcHash: '', label: '' })).toBe(2)
    expect(resolveImage(svgs, { occurrence: 1, srcHash: '', label: '' })).toBe(-1)
    expect(resolveImage(svgs, { occurrence: 7, srcHash: '', label: '' })).toBe(-1)
  })
})

describe('the contract', () => {
  test('the request takes a loose image anchor, the view a strict one with a spot or none', () => {
    expect(
      AnnotateBody.parse({ image: { occurrence: 1, srcHash: 'aaaaaaaa', label: 'Home' }, comment: 'x' }).image,
    ).toEqual({
      occurrence: 1,
      srcHash: 'aaaaaaaa',
      label: 'Home',
    })
    expect(ImageAnchor.parse({ occurrence: 0, srcHash: '', label: '' })).toEqual({
      occurrence: 0,
      srcHash: '',
      label: '',
      x: null,
      y: null,
    })
    expect(ImageAnchor.safeParse({ occurrence: 0, srcHash: '', label: '', x: 1.2, y: 0 }).success).toBe(false)
    expect(ImageAnchor.safeParse({ occurrence: -1, srcHash: '', label: '' }).success).toBe(false)
  })

  test('an annotation in the artifact view has no image unless it hangs on one', () => {
    const base = {
      id: 'a',
      revision: 1,
      quote: 'q',
      path: null,
      comment: 'c',
      author: 'owner' as const,
      at: '2026-11-19T10:00:00Z',
      editedAt: null,
      disposition: null,
    }
    const shape = ArtifactDetail.shape.annotations.element
    expect(shape.parse(base).image).toBeNull()
    expect(
      shape.parse({ ...base, image: { occurrence: 0, srcHash: 'aaaaaaaa', label: 'L', x: 0.5, y: 0.25 } }).image,
    ).toMatchObject({
      x: 0.5,
      y: 0.25,
    })
  })
})
