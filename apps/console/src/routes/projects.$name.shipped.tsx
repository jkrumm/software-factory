import { createFileRoute } from '@tanstack/react-router'
import { ProductionSection, ShippedHistory } from '@/components/project/activity'
import { ProjectTabSkeleton } from '@/components/skeletons'
import { useMediaQuery } from '@/lib/media'
import { useNow } from '@/lib/now'
import { prefetchProjectTab, useProjectPage } from '@/lib/queries'

/** Shipped: what closed in the last 7 days by day, and production as the factory knows it. Reads only the page. */
export const Route = createFileRoute('/projects/$name/shipped')({
  loader: ({ params }) => prefetchProjectTab(params.name, 'shipped'),
  component: ProjectShipped,
})

function ProjectShipped() {
  const { name } = Route.useParams()
  const page = useProjectPage(name)
  const now = useNow(30_000)
  const wide = useMediaQuery('(min-width: 768px)')
  if (!page.data) return <ProjectTabSkeleton />
  return (
    <div className="grid gap-10">
      <ProductionSection page={page.data} now={now} />
      <ShippedHistory page={page.data} now={now} side={wide ? 'right' : 'bottom'} />
    </div>
  )
}
