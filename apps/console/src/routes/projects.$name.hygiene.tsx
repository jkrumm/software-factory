import { createFileRoute } from '@tanstack/react-router'
import { HygieneSection } from '@/components/project/setup'
import { ProjectTabSkeleton } from '@/components/skeletons'
import { useNow } from '@/lib/now'
import { prefetchProjectTab, useProjectHygiene } from '@/lib/queries'

/** Hygiene: the probe catalogue with each probe's state and the open findings. Reads only the hygiene. */
export const Route = createFileRoute('/projects/$name/hygiene')({
  loader: ({ params }) => prefetchProjectTab(params.name, 'hygiene'),
  component: ProjectHygiene,
})

function ProjectHygiene() {
  const { name } = Route.useParams()
  const hygiene = useProjectHygiene(name)
  const now = useNow(30_000)
  if (!hygiene.data) return <ProjectTabSkeleton />
  return <HygieneSection model={hygiene.data} now={now} />
}
