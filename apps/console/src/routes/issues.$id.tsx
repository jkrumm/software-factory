import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Activity } from '@/components/issue/activity'
import { ChainAround, Properties } from '@/components/issue/aside'
import { Checkpoints } from '@/components/issue/checkpoints'
import { Evidence } from '@/components/issue/evidence'
import { Header } from '@/components/issue/header'
import { Overview } from '@/components/issue/overview'
import { IssueSkeleton } from '@/components/issue/skeleton'
import { TONE_TEXT, TONE_TINT } from '@/components/kit/tone'
import { EmptyState, Page } from '@/components/page'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { ApiError } from '@/lib/api'
import { checkpointTally, TAB_KEYS, TAB_LABEL, type TabKey, tabCounts, tabOf } from '@/lib/issue-page'
import { useNow } from '@/lib/now'
import { useIssue } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/issues/$id')({
  /** `?tab=activity|evidence|checkpoints`; the overview is the bare address. */
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } => {
    const tab = tabOf(search.tab)
    return tab === 'overview' ? {} : { tab }
  },
  component: IssuePage,
})

function IssuePage() {
  const { id } = Route.useParams()
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const now = useNow(30_000)
  const { data, error } = useIssue(id)

  if (!data) {
    if (error instanceof ApiError && error.status === 404)
      return (
        <Page wide>
          <EmptyState title="No such Issue">It may have a different number than the link says.</EmptyState>
        </Page>
      )
    if (error)
      return (
        <Page wide>
          <EmptyState title="This Issue is not available">
            The factory could not be reached. It will try again.
          </EmptyState>
        </Page>
      )
    return (
      <Page wide>
        <IssueSkeleton />
      </Page>
    )
  }

  const counts = tabCounts(data)
  const open = checkpointTally(data).open
  return (
    <Page wide>
      <div className="flex flex-col gap-8">
        <Header issue={data} now={now} />
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Tabs
            value={tabOf(tab)}
            onValueChange={(value) => {
              const next = tabOf(value)
              void navigate({ search: next === 'overview' ? {} : { tab: next }, replace: true })
            }}
          >
            <TabsList aria-label="Issue sections">
              {TAB_KEYS.map((key) => (
                <TabsTab key={key} value={key}>
                  {TAB_LABEL[key]}
                  {counts[key] === null ? null : (
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">{counts[key]}</span>
                  )}
                  {key === 'checkpoints' && open > 0 ? (
                    <span
                      className={cn(
                        'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs font-medium tabular-nums',
                        TONE_TINT.warn,
                        TONE_TEXT.warn,
                      )}
                    >
                      <span className="sr-only">Open: </span>
                      {open}
                    </span>
                  ) : null}
                </TabsTab>
              ))}
            </TabsList>
            <TabsPanel value="overview">
              <Overview issue={data} now={now} />
            </TabsPanel>
            <TabsPanel value="activity">
              <Activity issue={data} now={now} />
            </TabsPanel>
            <TabsPanel value="evidence">
              <Evidence issue={data} now={now} />
            </TabsPanel>
            <TabsPanel value="checkpoints">
              <Checkpoints issue={data} now={now} />
            </TabsPanel>
          </Tabs>
          <aside aria-label="About this Issue" className="flex min-w-0 flex-col gap-8">
            <Properties issue={data} now={now} />
            <ChainAround issue={data} />
          </aside>
        </div>
      </div>
    </Page>
  )
}
