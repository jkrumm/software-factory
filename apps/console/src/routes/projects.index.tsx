import { createFileRoute } from '@tanstack/react-router'
import { ProjectCard } from '@/components/project/card'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ProjectIndexSkeleton } from '@/components/skeletons'
import { ageWords } from '@/lib/age'
import { hygieneLine } from '@/lib/project'
import { useNow } from '@/lib/now'
import { projectIndexQuery, queryClient, useProjectDigests, useProjectIndex } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'

export const Route = createFileRoute('/projects/')({
  loader: () => void queryClient.prefetchQuery(projectIndexQuery),
  component: Projects,
})

function Projects() {
  const index = useProjectIndex()
  const digests = useProjectDigests()
  const screen = useScreen(index)
  const note = useScreenNote(screen, index.error)
  const now = useNow(30_000)

  if (!index.data)
    return (
      <Page fluid>
        <PageHeader title="Projects" loading={screen === 'loading'} note={note} />
        {screen === 'loading' ? <ProjectIndexSkeleton /> : null}
      </Page>
    )

  // the busiest first (working, then waiting and queued), then by name
  const projects = [...index.data.projects].sort(
    (a, b) =>
      b.counts.working - a.counts.working ||
      b.counts.waiting + b.counts.queued - (a.counts.waiting + a.counts.queued) ||
      a.name.localeCompare(b.name),
  )
  const headlines = new Map((digests.data?.projects ?? []).map((digest) => [digest.project, digest.headline]))
  if (projects.length === 0)
    return (
      <Page>
        <PageHeader title="Projects" />
        <EmptyState title="No project yet">A repo shows here once the factory has read its project.yaml.</EmptyState>
      </Page>
    )
  return (
    <Page fluid>
      <PageHeader title="Projects" note={`${projects.length} projects the factory has read`} />
      <ul aria-label="Projects" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {projects.map((project) => (
          <li key={project.name} className="min-w-0">
            <ProjectCard
              project={project}
              headline={headlines.get(project.name) ?? null}
              hygiene={hygieneLine(project.hygiene, now, ageWords)}
            />
          </li>
        ))}
      </ul>
    </Page>
  )
}
