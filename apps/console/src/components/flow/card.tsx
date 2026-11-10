import { Link } from '@tanstack/react-router'
import { IssueCard } from '@/components/kit'
import type { FlowCard } from '@/lib/flow'
import { originWord } from '@/lib/flow'

/**
 * One Issue on the board: the kit's IssueCard, the whole card a link to the Issue page. The number shows next to the project. The state
 * Lozenge shows only where the column does not already say it (the Closed recently column shows the outcome).
 */
export function FlowCardView({ card, now, showState = false }: { card: FlowCard; now: number; showState?: boolean }) {
  const origin = originWord(card.origin)
  return (
    <IssueCard
      title={card.title}
      project={card.repo}
      projectAs={(props) => <Link to="/flow" search={{ project: card.repo }} {...props} />}
      kind={card.kind}
      number={card.number}
      state={card.state}
      showState={showState}
      origin={origin === 'You' ? undefined : origin}
      reason={card.reason}
      since={card.since}
      now={now}
      as={(props) => <Link to="/issues/$id" params={{ id: String(card.number) }} {...props} />}
    />
  )
}
