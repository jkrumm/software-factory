import { NEED_KINDS, type NeedKind } from '@software-factory/contract'
import { createFileRoute } from '@tanstack/react-router'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { useNeeds } from '@/lib/queries'

const KIND_LABEL: Record<NeedKind, string> = {
  decision: 'Decisions',
  review: 'Reviews',
  errand: 'Errands',
  held_signal: 'Held signals',
}

export const Route = createFileRoute('/needs-you')({
  /** `item` is the deep link of the later decision view: `/needs-you?item=<key>`. */
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === 'string' && search.item !== '' ? { item: search.item } : {},
  component: NeedsYou,
})

function NeedsYou() {
  const { data, isPending } = useNeeds()
  if (!data)
    return (
      <Page>
        {isPending ? (
          <PageHeader title="Needs you" note="Loading" />
        ) : (
          <PageHeader title="Needs you" note="No data yet" />
        )}
      </Page>
    )

  const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0)
  if (total === 0) {
    return (
      <Page>
        <PageHeader title="Needs you" />
        <EmptyState title="Nothing waits on you">The factory will say here when it needs a decision.</EmptyState>
      </Page>
    )
  }
  return (
    <Page>
      <PageHeader title="Needs you" note={`${total} waiting`} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {NEED_KINDS.filter((kind) => data.counts[kind] > 0).map((kind) => (
          <li key={kind} className="flex items-baseline justify-between rounded-xl border bg-card px-4 py-3">
            <span className="text-sm text-muted-foreground">{KIND_LABEL[kind]}</span>
            <span className="font-heading text-2xl font-semibold tabular-nums">{data.counts[kind]}</span>
          </li>
        ))}
      </ul>
    </Page>
  )
}
