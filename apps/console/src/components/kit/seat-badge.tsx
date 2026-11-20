import type { LeadSeat } from '@software-factory/contract'
import { cn } from '@/lib/utils'

const TIER_LETTER: Record<LeadSeat['tier'], string> = { haiku: 'H', sonnet: 'S', opus: 'O' }
const EFFORT_LETTER: Record<LeadSeat['effort'], string> = { low: 'L', medium: 'M', high: 'H', xhigh: 'X', max: 'XX' }
const EFFORT_WORDS: Record<LeadSeat['effort'], string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra-high',
  max: 'max',
}

const capital = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

/** The badge's letters: the tier (H, S, O) and the effort (L, M, H, X, XX for max): `SH` is Sonnet at high effort. */
export const seatCode = ({ tier, effort }: Pick<LeadSeat, 'tier' | 'effort'>): string =>
  `${TIER_LETTER[tier]}${EFFORT_LETTER[effort]}`

/**
 * The tooltip: `Haiku, high effort — light role (rule hygiene:links)`, with `Will start on ` first for a seat the lead has not
 * started on yet. A planned seat that waits for the Issue's size says so: it may still start light.
 */
export function seatWords(seat: LeadSeat): string {
  const rule = seat.rule ? ` (rule ${seat.rule})` : ''
  const seatWord = `${capital(seat.tier)}, ${EFFORT_WORDS[seat.effort]} effort${seat.role ? ` — ${seat.role} role` : ''}${rule}`
  if (!seat.planned) return seatWord
  return `Will start on ${seatWord}${seat.sizeKnown ? '' : '; size not known yet, it may still start light'}`
}

/**
 * The seat of an Issue's lead as two or three letters in mono, between the Issue's number and its state: solid for the seat
 * the current attempt started on, dashed and muted for the one it will start on. The words are its tooltip and its name.
 * Nothing when no seat is known.
 */
export function SeatBadge({ seat, className }: { seat: LeadSeat | null | undefined; className?: string }) {
  if (!seat) return null
  const words = seatWords(seat)
  return (
    <span
      role="img"
      aria-label={words}
      title={words}
      data-planned={seat.planned}
      className={cn(
        'relative z-10 inline-flex h-5 shrink-0 items-center rounded-md px-1 font-mono text-xs font-medium tabular-nums',
        seat.planned
          ? 'border border-dashed border-muted-foreground/50 text-muted-foreground'
          : 'bg-muted text-foreground',
        className,
      )}
    >
      {seatCode(seat)}
    </span>
  )
}
