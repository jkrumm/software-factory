import { Activity } from '@/components/issue/activity'
import { ChainAround, Properties } from '@/components/issue/aside'
import { Checkpoints } from '@/components/issue/checkpoints'
import { Evidence } from '@/components/issue/evidence'
import { Header } from '@/components/issue/header'
import { Overview } from '@/components/issue/overview'
import { IssueSkeleton } from '@/components/issue/skeleton'
import { TONE_TEXT, TONE_TINT } from '@/components/kit/tone'
import { EmptyState } from '@/components/page'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { ApiError } from '@/lib/api'
import { useScreen } from '@/lib/screen'
import { checkpointTally, TAB_KEYS, TAB_LABEL, type TabKey, tabCounts, tabOf } from '@/lib/issue-page'
import { useNow } from '@/lib/now'
import { useIssue } from '@/lib/queries'
import { cn } from '@/lib/utils'

/** What the Issue shows while it loads or when it cannot be shown. `narrow`: the column is a panel's, not the page's. */
export function IssueGap({ id, narrow }: { id: string; narrow?: boolean }) {
  const issue = useIssue(id)
  const { error } = issue
  const screen = useScreen(issue)
  if (error instanceof ApiError && error.status === 404)
    return <EmptyState title="No such Issue">It may have a different number than the link says.</EmptyState>
  if (screen === 'failed')
    return (
      <EmptyState title="This Issue is not available">The factory could not be reached. It will try again.</EmptyState>
    )
  return <IssueSkeleton narrow={narrow} />
}

/**
 * The Issue: header, tabs and the properties beside them (under them in a `peek`, where the column is narrow). The page
 * and the peek panel show this one view; the tab is the caller's (a search param either way).
 */
export function IssueView({
  id,
  tab,
  onTab,
  peek,
}: {
  id: string
  tab: TabKey | undefined
  onTab: (tab: TabKey) => void
  peek?: boolean
}) {
  const now = useNow(30_000)
  const { data } = useIssue(id)
  if (!data) return <IssueGap id={id} narrow={peek} />

  const counts = tabCounts(data)
  const open = checkpointTally(data).open
  return (
    <div className="flex flex-col gap-8">
      <Header issue={data} now={now} narrow={peek} />
      <div className={cn('grid items-start gap-8', !peek && 'lg:grid-cols-[minmax(0,1fr)_22rem]')}>
        <Tabs value={tabOf(tab)} onValueChange={(value) => onTab(tabOf(value))}>
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
            <Overview issue={data} now={now} narrow={peek} />
          </TabsPanel>
          <TabsPanel value="activity">
            <Activity issue={data} now={now} narrow={peek} />
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
  )
}
