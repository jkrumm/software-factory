import { Link } from '@tanstack/react-router'
import { IssueCard } from '@/components/kit'
import type { FlowCard } from '@/lib/flow'
import { originWord } from '@/lib/flow'

/**
 * One Issue on the board: the kit's IssueCard, the whole card a link to the Issue page. No id on screen. The state
 * Lozenge shows only where the column does not already say it (the Closed recently column shows the outcome).
 */
export function FlowCardView({ card, now, showState = false }: { card: FlowCard; now: number; showState?: boolean }) {
  return (
    <IssueCard
      title={card.title}
      project={card.repo}
      kind={card.kind}
      state={card.state}
      showState={showState}
      origin={originWord(card.origin)}
      reason={card.reason}
      since={card.since}
      now={now}
      as={(props) => <Link to="/issues/$id" params={{ id: String(card.number) }} {...props} />}
    />
  )
}
