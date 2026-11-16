import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { Lozenge } from '@/components/kit'
import { Age, IssueNumber } from '@/components/kit/issue-parts'
import { KindIcon } from '@/components/kit/kind-badge'
import { LINK, Table, TD, TH } from '@/components/project/parts'
import { useIsPeeked } from '@/components/peek/use-peeked'
import { type FlowCard, originWord, type Sort, type SortKey } from '@/lib/flow'
import { cn } from '@/lib/utils'

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: 'number', label: 'Issue' },
  { key: 'title', label: 'Title' },
  { key: 'project', label: 'Project' },
  { key: 'origin', label: 'Origin' },
  { key: 'state', label: 'State' },
  { key: 'since', label: 'Since' },
]

function SortHead({
  column,
  sort,
  onSort,
}: {
  column: (typeof COLUMNS)[number]
  sort: Sort
  onSort: (key: SortKey) => void
}) {
  const active = sort.key === column.key
  const Caret = sort.direction === 'asc' ? CaretUpIcon : CaretDownIcon
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={TH}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          active && 'text-foreground',
        )}
      >
        {column.label}
        {active ? <Caret weight="bold" aria-hidden="true" className="size-3" /> : null}
      </button>
    </th>
  )
}

function Row({ card, now }: { card: FlowCard; now: number }) {
  const selected = useIsPeeked(card.number)
  return (
    <tr
      data-testid="flow-row"
      aria-current={selected ? 'true' : undefined}
      className={cn('transition-colors hover:bg-accent', selected && 'bg-accent')}
    >
      <td className={cn(TD, 'whitespace-nowrap')}>
        <span className="inline-flex items-center gap-2">
          <KindIcon kind={card.kind} />
          <IssueNumber number={card.number} />
        </span>
      </td>
      <td className={cn(TD, 'min-w-48')}>
        <Link to="/issues/$id" params={{ id: String(card.number) }} className={cn(LINK, 'font-medium wrap-anywhere')}>
          {card.title}
        </Link>
        {card.reason ? <p className="text-xs text-muted-foreground wrap-anywhere">{card.reason}</p> : null}
      </td>
      <td className={TD}>
        <Link to="/projects/$name" params={{ name: card.repo }} className={cn(LINK, 'text-muted-foreground')}>
          {card.repo}
        </Link>
      </td>
      <td className={cn(TD, 'whitespace-nowrap text-muted-foreground')}>{originWord(card.origin)}</td>
      <td className={TD}>
        <Lozenge state={card.state} />
      </td>
      <td className={cn(TD, 'whitespace-nowrap')}>
        <Age since={card.since} now={now} />
      </td>
    </tr>
  )
}

/**
 * The Issues of one filter as a plain table, sorted by the pressed column (`aria-sort` says which). Every row opens the
 * Issue (in the peek); the project opens its page. No virtualisation: a list is one state or one project, a few dozen rows.
 */
export function IssueTable({
  label,
  cards,
  sort,
  onSort,
  now,
}: {
  label: string
  cards: readonly FlowCard[]
  sort: Sort
  onSort: (key: SortKey) => void
  now: number
}) {
  return (
    <Table
      label={label}
      head={COLUMNS.map((column) => (
        <SortHead key={column.key} column={column} sort={sort} onSort={onSort} />
      ))}
    >
      {cards.map((card) => (
        <Row key={card.key} card={card} now={now} />
      ))}
    </Table>
  )
}
