import { createFileRoute } from '@tanstack/react-router'
import { ProjectTable } from '@/components/project/table'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ProjectIndexSkeleton } from '@/components/skeletons'
import { useNow } from '@/lib/now'
import { projectIndexQuery, queryClient, useProjectIndex } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'

export const Route = createFileRoute('/projects/')({
  loader: () => void queryClient.prefetchQuery(projectIndexQuery),
  component: Projects,
})

/** Every project in one table: one request (`GET /v1/projects`) carries every figure, the digest previews included. */
function Projects() {
  const index = useProjectIndex()
  const screen = useScreen(index)
  const note = useScreenNote(screen, index.error)
  const now = useNow(30_000)

  if (!index.data)
    return (
      <Page fluid>
        <PageHeader title="Projects" compact loading={screen === 'loading'} note={note} />
        {screen === 'loading' ? <ProjectIndexSkeleton /> : null}
      </Page>
    )

  const { projects } = index.data
  if (projects.length === 0)
    return (
      <Page>
        <PageHeader title="Projects" />
        <EmptyState title="No project yet">A repo shows here once the factory has read its project.yaml.</EmptyState>
      </Page>
    )
  const moving = projects.filter((p) => p.shipped.hours.some((n) => n > 0)).length
  const running = projects.reduce((sum, p) => sum + p.leads.running, 0)
  return (
    <Page fluid>
      <PageHeader
        title="Projects"
        compact
        note={`${projects.length} projects, ${moving} shipped in 7 days, ${running} leads running${index.data.seats === null ? '' : ` of ${index.data.seats} seats`}`}
      />
      <ProjectTable model={index.data} now={now} />
      <p className="mt-3 text-xs text-muted-foreground">
        Set from a terminal: <code className="font-mono">factory queue prio 5 --project &lt;name&gt;</code> (a higher
        project starts first among Issues of one priority) and{' '}
        <code className="font-mono">factory queue set drain --project &lt;name&gt;</code> (
        <code className="font-mono">run</code> starts it again).
      </p>
    </Page>
  )
}
