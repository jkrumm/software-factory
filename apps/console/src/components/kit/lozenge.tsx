import { cn } from '@/lib/utils'
import { TONE_TEXT, TONE_TINT, type Tone } from './tone'

export const LOZENGE_STATES = [
  'settling',
  'queued',
  'working',
  'waiting',
  'watching',
  'closed',
  'done',
  'dropped',
  'healed',
  'cancelled',
] as const

/** An Issue's state (`docs/language.md` State) or, once closed, its outcome (Outcome). */
export type LozengeState = (typeof LOZENGE_STATES)[number]

/** The tone of each state, decided here and nowhere else: never derived from the word. */
export const LOZENGE_TONES: Record<LozengeState, Tone> = {
  settling: 'neutral',
  queued: 'neutral',
  working: 'accent',
  waiting: 'warn',
  watching: 'accent',
  closed: 'neutral',
  done: 'good',
  dropped: 'neutral',
  healed: 'good',
  cancelled: 'neutral',
}

export interface LozengeProps {
  state: LozengeState
  /** The words shown; default the state with a capital. */
  children?: string
  className?: string
}

/** A state as text on a 12 % tint of its tone. */
export function Lozenge({ state, children, className }: LozengeProps) {
  const tone = LOZENGE_TONES[state]
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap',
        TONE_TINT[tone],
        TONE_TEXT[tone],
        className,
      )}
    >
      {children ?? `${state.charAt(0).toUpperCase()}${state.slice(1)}`}
    </span>
  )
}
