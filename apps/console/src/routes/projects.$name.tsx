import { createFileRoute, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ApiError } from '@/lib/api'
import { ProjectChrome } from '@/components/project/chrome'
import { LINK } from '@/components/project/parts'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ProjectSkeleton } from '@/components/skeletons'
import { useNow } from '@/lib/now'
import { prefetchProject, useProjectPage } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'

/**
 * A project's page: its name, a switcher between projects and the tabs, with the tab's screen below. The project's own
 * address is the first screen (is it healthy, what moves, what is next, what shipped); `work`, `plan`, `shipped`,
 * `hygiene` and `setup` are the tabs, each with its own address and its own reads.
 */
export const Route = createFileRoute('/projects/$name')({
  /** Starts the read of the page without waiting for it: a hover or focus on any link to it runs this (intent preload). */
  loader: ({ params }) => prefetchProject(params.name),
  component: ProjectLayout,
})

function ProjectLayout() {
  const { name } = Route.useParams()
  const page = useProjectPage(name)
  const screen = useScreen(page)
  const note = useScreenNote(screen, page.error)
  const now = useNow(30_000)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // an address by the repo's path (a chip on a card of a project whose name was taken) lands on the project's own name
  const canonical = page.data?.name
  useEffect(() => {
    if (canonical && canonical !== name) {
      const rest = pathname.replace(/^\/projects\/[^/]+/, '')
      void navigate({ to: `/projects/${encodeURIComponent(canonical)}${rest}`, replace: true })
    }
  }, [canonical, name, navigate, pathname])

  if (page.error instanceof ApiError && page.error.status === 404 && !page.data) {
    return (
      <Page>
        <PageHeader title={name} />
        <EmptyState title="No project of that name">
          The factory has not read a project called {name}.{' '}
          <Link to="/projects" className={LINK}>
            All projects
          </Link>
        </EmptyState>
      </Page>
    )
  }
  if (!page.data) {
    return (
      <Page fluid>
        <PageHeader title={name} loading={screen === 'loading'} note={note} />
        {screen === 'loading' ? <ProjectSkeleton /> : null}
      </Page>
    )
  }
  return (
    <Page fluid>
      <ProjectChrome page={page.data} now={now} />
      <Outlet />
    </Page>
  )
}
