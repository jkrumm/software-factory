import { createFileRoute } from '@tanstack/react-router'
import { MonitorsSection } from '@/components/project/activity'
import { SetupForm } from '@/components/project/setup'
import { ProjectTabSkeleton } from '@/components/skeletons'
import { prefetchProjectTab, useProjectPage, useProjectSetup } from '@/lib/queries'

/** Setup: the project.yaml as a described form with the file behind a toggle, and the monitors that file alerts here. */
export const Route = createFileRoute('/projects/$name/setup')({
  loader: ({ params }) => prefetchProjectTab(params.name, 'setup'),
  component: ProjectSetup,
})

function ProjectSetup() {
  const { name } = Route.useParams()
  const setup = useProjectSetup(name)
  const page = useProjectPage(name)
  if (!setup.data || !page.data) return <ProjectTabSkeleton />
  return (
    <div className="grid gap-10">
      <SetupForm model={setup.data} />
      <MonitorsSection page={page.data} />
    </div>
  )
}
