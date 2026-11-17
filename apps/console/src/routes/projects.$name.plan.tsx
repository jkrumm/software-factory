import { createFileRoute } from '@tanstack/react-router'
import { PlanTable } from '@/components/project/activity'
import { ProjectTabSkeleton } from '@/components/skeletons'
import { prefetchProjectTab, useProjectPlan } from '@/lib/queries'

/** Plan: every row of the plan with its state and why, and how far it is. Reads only the plan. */
export const Route = createFileRoute('/projects/$name/plan')({
  loader: ({ params }) => prefetchProjectTab(params.name, 'plan'),
  component: ProjectPlan,
})

function ProjectPlan() {
  const { name } = Route.useParams()
  const plan = useProjectPlan(name)
  if (!plan.data) return <ProjectTabSkeleton />
  return <PlanTable project={name} rows={plan.data.rows} error={plan.data.error} warnings={plan.data.warnings} />
}
