import { createFileRoute } from '@tanstack/react-router'
import { WorkList } from '@/components/project/activity'
import { ProjectTabSkeleton } from '@/components/skeletons'
import { useNow } from '@/lib/now'
import { prefetchProjectTab, useFlow, useProjectPage } from '@/lib/queries'

/** Work: every open Issue of the project, sortable. Reads only the cached Flow. */
export const Route = createFileRoute('/projects/$name/work')({
  loader: ({ params }) => prefetchProjectTab(params.name, 'work'),
  component: ProjectWork,
})

function ProjectWork() {
  const { name } = Route.useParams()
  const page = useProjectPage(name)
  const flow = useFlow()
  const now = useNow(30_000)
  if (!page.data || !flow.data) return <ProjectTabSkeleton />
  return <WorkList project={page.data} flow={flow.data} now={now} />
}
