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

interface LozengeBase {
  className?: string
}

export type LozengeProps = LozengeBase &
  (
    | {
        state: LozengeState
        /** The words shown; default the state with a capital. */
        children?: string
        tone?: undefined
      }
    | {
        state?: undefined
        /** An explicit tone, for a state that is not an Issue's (a session's, a ship's): the words are then required. */
        tone: Tone
        children: string
      }
  )

/** A state as text on a 12 % tint of its tone. */
export function Lozenge(props: LozengeProps) {
  const { className } = props
  const tone = props.tone === undefined ? LOZENGE_TONES[props.state] : props.tone
  const words =
    props.children ?? (props.tone === undefined ? `${props.state.charAt(0).toUpperCase()}${props.state.slice(1)}` : '')
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
      {words}
    </span>
  )
}
