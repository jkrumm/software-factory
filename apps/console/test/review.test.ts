import { describe, expect, test } from 'bun:test'
import type { ArtifactDetail } from '@software-factory/contract'
import { type Delivery, highlightAnchors, imageComments, reviewItems } from '../src/lib/review.ts'

type Annotation = ArtifactDetail['annotations'][number]

const base: Annotation = {
  id: 'a1',
  revision: 1,
  quote: 'Image 2: Queue screen',
  path: 'Screens',
  occurrence: null,
  prefix: null,
  suffix: null,
  image: { occurrence: 1, srcHash: 'a1b2c3d4', label: 'Queue screen', x: null, y: null },
  comment: 'Too narrow.',
  author: 'owner',
  at: '2026-11-19T10:00:00.000Z',
  editedAt: null,
  disposition: null,
}
const text: Annotation = { ...base, id: 'a2', quote: 'The queue', image: null, comment: 'Why?' }
const detail = (annotations: Annotation[], unanchored: Annotation[] = []) =>
  ({ annotations, unanchored }) as unknown as ArtifactDetail

describe('comments on pictures in the review', () => {
  test('a picture comment is drawn on its picture, not painted as a passage', () => {
    const items = reviewItems(detail([base, text]), [])
    expect(highlightAnchors(items).map((a) => a.id)).toEqual(['a2'])
    expect(imageComments(items)).toEqual([
      {
        id: 'a1',
        occurrence: 1,
        srcHash: 'a1b2c3d4',
        label: 'Queue screen',
        x: null,
        y: null,
        author: 'owner',
        text: 'Too narrow.',
      },
    ])
  })

  test('one whose picture is gone from the revision is not drawn', () => {
    expect(imageComments(reviewItems(detail([], [base]), []))).toEqual([])
  })

  test('a comment that is on its way shows on its picture at once, spot and all', () => {
    const pending: Delivery = {
      kind: 'create',
      key: 'w1',
      state: 'sending',
      error: null,
      at: '2026-11-19T10:05:00.000Z',
      body: {
        revision: 1,
        quote: 'Image 3: Settings screen · spot 50% / 25%',
        image: { occurrence: 2, srcHash: 'c3d4e5f6', label: 'Settings screen', x: 0.5, y: 0.25 },
        comment: 'A switch, please.',
      },
    }
    const [item] = reviewItems(detail([]), [pending])
    expect(item?.image).toEqual({ occurrence: 2, srcHash: 'c3d4e5f6', label: 'Settings screen', x: 0.5, y: 0.25 })
    expect(imageComments(item ? [item] : [])[0]).toMatchObject({
      id: 'pending:w1',
      x: 0.5,
      y: 0.25,
      text: 'A switch, please.',
    })
  })

  test('a long comment is cut for the frame', () => {
    const [item] = reviewItems(detail([{ ...base, comment: 'x'.repeat(900) }]), [])
    expect(imageComments(item ? [item] : [])[0]?.text).toHaveLength(500)
  })
})
