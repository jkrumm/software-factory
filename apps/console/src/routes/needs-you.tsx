import { NEED_KINDS } from '@software-factory/contract'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { NeedCard } from '@/components/needs/card'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { KIND_LABEL } from '@/lib/needs'
import { useNeeds } from '@/lib/queries'

export const Route = createFileRoute('/needs-you')({
  /** `item` is the deep link of one item: `/needs-you?item=<key>`, also where `/checkpoints/<key>` lands. */
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === 'string' && search.item !== '' ? { item: search.item } : {},
  component: NeedsYou,
})

function NeedsYou() {
  const { data, isPending, dataUpdatedAt } = useNeeds()
  const { item: openId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [sent, setSent] = useState<string | null>(null)
  // a snapshot restored from storage may be older than the item: say it is settled only on data fetched since the page opened
  const openedAt = useRef(Date.now())

  const select = (id: string | undefined) => {
    setSent(null)
    void navigate({ search: id ? { item: id } : {}, replace: true })
  }
  const onSent = (message: string) => {
    setSent(message)
    void navigate({ search: {}, replace: true })
  }

  if (!data)
    return (
      <Page>
        <PageHeader title="Needs you" note={isPending ? 'Loading' : 'No data yet'} />
      </Page>
    )

  const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0)
  const unknown = openId !== undefined && dataUpdatedAt >= openedAt.current && !data.items.some((i) => i.id === openId)
  const notice = unknown ? (
    <p role="status" className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      That one is already settled.{' '}
      <Link to="/needs-you" search={{}} className="underline underline-offset-4">
        Back to the list
      </Link>
    </p>
  ) : sent ? (
    <p role="status" className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      {sent}
    </p>
  ) : null

  if (total === 0) {
    return (
      <Page>
        <PageHeader title="Needs you" />
        {notice}
        <EmptyState title="Nothing waits on you">The factory will say here when it needs a decision.</EmptyState>
      </Page>
    )
  }
  return (
    <Page>
      <PageHeader title="Needs you" note={`${total} waiting`} />
      {notice}
      <div className="grid gap-8">
        {NEED_KINDS.map((kind) => {
          const items = data.items.filter((i) => i.kind === kind)
          if (items.length === 0) return null
          return (
            <section key={kind} aria-labelledby={`needs-${kind}`} className="grid gap-3">
              <h2 id={`needs-${kind}`} className="text-sm font-medium text-muted-foreground">
                {KIND_LABEL[kind]} <span className="tabular-nums">{items.length}</span>
              </h2>
              {items.map((i) => (
                <NeedCard
                  key={i.id}
                  item={i}
                  open={openId === i.id}
                  onToggle={() => select(openId === i.id ? undefined : i.id)}
                  onSent={onSent}
                />
              ))}
            </section>
          )
        })}
      </div>
    </Page>
  )
}
