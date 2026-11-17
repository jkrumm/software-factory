import { createFileRoute } from '@tanstack/react-router'
import { Overview } from '@/components/project/overview'
import { prefetchProjectOverview } from '@/lib/queries'

/** The first screen of a project: health, what moves now, what is next, what shipped. */
export const Route = createFileRoute('/projects/$name/')({
  loader: ({ params }) => prefetchProjectOverview(params.name),
  component: ProjectOverview,
})

function ProjectOverview() {
  const { name } = Route.useParams()
  return <Overview name={name} />
}
