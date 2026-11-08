import type { FlowCard } from '@/lib/flow'
import { originWord } from '@/lib/flow'
import { ageWords } from '@/lib/age'

/** One Issue on the board. No id and no link: the Issue page does not exist yet. */
export function FlowCardView({ card, now }: { card: FlowCard; now: number }) {
  return (
    <div className="grid gap-1 rounded-xl border bg-card px-3 py-2.5 text-card-foreground">
      <p className="line-clamp-2 text-sm font-medium">{card.title}</p>
      <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{card.repo}</span>
        <span>{originWord(card.origin)}</span>
        <span>{ageWords(Math.max(0, now - Date.parse(card.since)))}</span>
      </p>
      {card.reason ? <p className="line-clamp-2 text-xs text-muted-foreground">{card.reason}</p> : null}
    </div>
  )
}
