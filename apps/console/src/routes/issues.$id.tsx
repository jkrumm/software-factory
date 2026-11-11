import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { IssueView } from '@/components/issue/view'
import { Page } from '@/components/page'
import { type TabKey, tabOf } from '@/lib/issue-page'
import { chainQuery, PREFETCH_STALE_MS, prefetchDetail, queryClient } from '@/lib/queries'

export const Route = createFileRoute('/issues/$id')({
  /** `?tab=activity|evidence|checkpoints`; the overview is the bare address. */
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } => {
    const tab = tabOf(search.tab)
    return tab === 'overview' ? {} : { tab }
  },
  /**
   * Starts the reads of the page without waiting for them (a hover or focus on any link to it runs this through the router's
   * intent preload): the page opens on its skeleton or, after a hover, on data. The chain is the aside's.
   */
  loader: ({ params }) => {
    prefetchDetail('issue', params.id)
    void queryClient.prefetchQuery({ ...chainQuery, staleTime: PREFETCH_STALE_MS })
  },
  component: IssuePage,
})

function IssuePage() {
  const { id } = Route.useParams()
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  return (
    <Page wide>
      <IssueView
        id={id}
        tab={tab}
        onTab={(next) => void navigate({ search: next === 'overview' ? {} : { tab: next }, replace: true })}
      />
    </Page>
  )
}
