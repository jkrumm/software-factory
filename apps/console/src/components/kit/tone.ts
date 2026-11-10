/** The tones the kit paints state with. A tone is chosen by the caller or an explicit map, never derived from a word. */
export type Tone = 'good' | 'warn' | 'bad' | 'accent' | 'neutral'

/** Text in a tone: used on a tint of the same tone, never as a series colour. */
export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-[color:var(--vx-good-solid)]',
  warn: 'text-[color:var(--vx-warn-solid)]',
  bad: 'text-[color:var(--vx-bad-solid)]',
  accent: 'text-[color:var(--vx-accent)]',
  neutral: 'text-[color:var(--vx-ink2)]',
}

/** The 12 % tint a tone's text sits on. */
export const TONE_TINT: Record<Tone, string> = {
  good: 'bg-[color-mix(in_srgb,var(--vx-good-solid)_12%,transparent)]',
  warn: 'bg-[color-mix(in_srgb,var(--vx-warn-solid)_12%,transparent)]',
  bad: 'bg-[color-mix(in_srgb,var(--vx-bad-solid)_12%,transparent)]',
  accent: 'bg-[color-mix(in_srgb,var(--vx-accent)_12%,transparent)]',
  neutral: 'bg-[color-mix(in_srgb,var(--vx-faint)_12%,transparent)]',
}

/** The colour of a mark (a line, a fill) in a tone, as a CSS value. */
export const TONE_MARK: Record<Tone, string> = {
  good: 'var(--vx-good-solid)',
  warn: 'var(--vx-warn-solid)',
  bad: 'var(--vx-bad-solid)',
  accent: 'var(--vx-accent)',
  neutral: 'var(--vx-line2)',
}

/** A mark colour at a share of its strength, over whatever sits behind. */
export const mix = (colour: string, percent: number): string => `color-mix(in srgb, ${colour} ${percent}%, transparent)`

/** A meter takes the warn tone from this share of its ceiling. */
export const METER_WARN_AT = 0.75
/** A meter takes the bad tone from this share of its ceiling. */
export const METER_BAD_AT = 0.9

/** Graphite below 75 %, warn from 75 %, bad from 90 %; a meter has no series colour. */
export function meterTone(share: number): Tone {
  if (share >= METER_BAD_AT) return 'bad'
  if (share >= METER_WARN_AT) return 'warn'
  return 'neutral'
}
