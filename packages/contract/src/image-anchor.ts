import * as z from 'zod'

/**
 * Where a comment hangs on a picture. A text comment hangs on a quote; a picture has none, so it names the picture three ways
 * and a revision that moves or reorders pictures still finds it: the hash of its `src`, its caption or alt text, and its place
 * among the document's pictures. The frame (public/frame/lightbox.js, between "image:begin" and "image:end") holds a copy of
 * `srcHash` and `resolveImage`; apps/console/test/image-anchor.test.ts runs both on one table of cases. Change them together.
 */

export const MAX_IMAGE_LABEL = 300
const MAX_OCCURRENCE = 2_147_483_647

/** The picture a comment hangs on, as the API returns it. `x` and `y` are a spot on it, 0..1 of its width and height, both or neither. */
export const ImageAnchor = z.object({
  /** the picture's 0-based place among the document's pictures (the lightbox's list) */
  occurrence: z.number().int().min(0).max(MAX_OCCURRENCE),
  /** `srcHash` of its `src` attribute as written; empty for an inline svg */
  srcHash: z.string().max(8),
  /** its figcaption, else alt (aria-label, svg title), whitespace folded */
  label: z.string().max(MAX_IMAGE_LABEL),
  x: z.number().min(0).max(1).nullable().default(null),
  y: z.number().min(0).max(1).nullable().default(null),
})
export type ImageAnchor = z.infer<typeof ImageAnchor>

/** The request form: every property optional, so the server names each missing one itself (422 `missing_field`). */
export const ImageAnchorInput = z.object({
  occurrence: z.number().int().optional(),
  srcHash: z.string().optional(),
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
})

/** FNV-1a over the UTF-16 code units, eight hex digits: a name for a `src`, not a secret. No crypto: the frame has none to rely on. */
export function srcHash(src: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < src.length; i++) {
    hash ^= src.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The quote a picture comment is stored with: the store wants one, and a lead reads it in `artifact show`. */
export function imageQuote(image: { occurrence: number; label: string; x?: number | null; y?: number | null }): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`
  const spot =
    typeof image.x === 'number' && typeof image.y === 'number'
      ? ` · spot ${percent(image.x)} / ${percent(image.y)}`
      : ''
  return `Image ${image.occurrence + 1}${image.label ? `: ${image.label}` : ''}${spot}`
}

/** One picture of a revision as resolution sees it: the hash of its src ('' for an svg) and its label. */
export interface ImageRef {
  hash: string
  label: string
}

/**
 * The index of the picture a comment hangs on among `refs` (the revision's pictures in order), or -1. The picture with the
 * same src hash (among several, the one with the same label, then the nearest in place); else the one with the same label
 * (the nearest in place); else, for a picture that had neither a src nor a label, the one at the same place that has neither.
 * A picture replaced by one with another src and label is gone, never a comment moved onto the wrong picture.
 */
export function resolveImage(
  refs: readonly ImageRef[],
  hint: { occurrence: number; srcHash: string; label: string },
): number {
  const nearest = (found: number[]) =>
    found.reduce((best, at) => (Math.abs(at - hint.occurrence) < Math.abs(best - hint.occurrence) ? at : best))
  const where = (test: (ref: ImageRef) => boolean) => refs.flatMap((ref, at) => (test(ref) ? [at] : []))
  if (hint.srcHash !== '') {
    const same = where((ref) => ref.hash === hint.srcHash)
    if (same.length > 0) {
      const named = hint.label === '' ? [] : same.filter((at) => refs[at]?.label === hint.label)
      return nearest(named.length > 0 ? named : same)
    }
  }
  if (hint.label !== '') {
    const same = where((ref) => ref.label === hint.label)
    return same.length > 0 ? nearest(same) : -1
  }
  if (hint.srcHash !== '') return -1
  const there = refs[hint.occurrence]
  return there?.hash === '' && there.label === '' ? hint.occurrence : -1
}
