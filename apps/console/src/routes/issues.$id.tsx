import { createFileRoute } from '@tanstack/react-router'
import {
  Artifacts,
  Decisions,
  Facts,
  Header,
  History,
  Notes,
  Sessions,
  Shipping,
  Triage,
} from '@/components/issue/sections'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ApiError } from '@/lib/api'
import { useIssue } from '@/lib/queries'

export const Route = createFileRoute('/issues/$id')({ component: IssuePage })

function IssuePage() {
  const { id } = Route.useParams()
  const { data, error, isPending } = useIssue(id)

  if (!data) {
    if (error instanceof ApiError && error.status === 404)
      return (
        <Page>
          <EmptyState title="No such Issue">It may have a different number than the link says.</EmptyState>
        </Page>
      )
    if (error)
      return (
        <Page>
          <EmptyState title="This Issue is not available">
            The factory could not be reached. It will try again.
          </EmptyState>
        </Page>
      )
    return (
      <Page>
        <PageHeader title="Issue" note={isPending ? 'Loading' : 'No data yet'} />
      </Page>
    )
  }

  const now = Date.now()
  return (
    <Page>
      <Header issue={data} now={now} />
      <div className="grid gap-8">
        <Facts issue={data} now={now} />
        <Triage issue={data} now={now} />
        <Sessions issue={data} now={now} />
        <Notes issue={data} now={now} />
        <Decisions issue={data} now={now} />
        <Artifacts issue={data} now={now} />
        <Shipping issue={data} now={now} />
        <History issue={data} now={now} />
      </div>
    </Page>
  )
}
