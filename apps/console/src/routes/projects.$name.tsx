import { CheckCircleIcon, ListChecksIcon, ShieldCheckIcon } from '@phosphor-icons/react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ApiError } from '@/lib/api'
import { HygieneSection, SetupSection } from '@/components/project/setup'
import { NowSection, PlanSection, ProductionSection, ShippedSection } from '@/components/project/activity'
import { LINK } from '@/components/project/parts'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection } from '@/components/sidebar'
import { StatCard } from '@/components/kit'
import { ProjectSkeleton } from '@/components/skeletons'
import { ageWords } from '@/lib/age'
import { dayLabels, hygieneLine, planSummary } from '@/lib/project'
import { shortDate } from '@/lib/flow'
import { useMediaQuery } from '@/lib/media'
import { useNow } from '@/lib/now'
import {
  prefetchProject,
  useFlow,
  useProjectHygiene,
  useProjectIndex,
  useProjectPage,
  useProjectPlan,
} from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'

export const Route = createFileRoute('/projects/$name')({
  /** Starts the reads of the page without waiting for them: a hover or focus on any link to it runs this (intent preload). */
  loader: ({ params }) => prefetchProject(params.name),
  component: ProjectPage,
})

const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0)

/** The other projects, as the page's own section of the sidebar: one click moves between them. */
function ProjectsSidebar({ name }: { name: string }) {
  const index = useProjectIndex()
  const projects = (index.data?.projects ?? []).filter((p) => !p.work || p.name === name)
  return (
    <SidebarSection title="Projects">
      {projects.map((project) => (
        <SidebarEntry
          key={project.name}
          label={project.name}
          current={project.name === name}
          open={{
            running: project.counts.working,
            pending: project.counts.waiting + project.counts.queued,
          }}
          render={(props) => <Link to="/projects/$name" params={{ name: project.name }} {...props} />}
        />
      ))}
    </SidebarSection>
  )
}

function ProjectPage() {
  const { name } = Route.useParams()
  const page = useProjectPage(name)
  const plan = useProjectPlan(name)
  const hygiene = useProjectHygiene(name)
  const flow = useFlow()
  const screen = useScreen(page)
  const note = useScreenNote(screen, page.error)
  const now = useNow(30_000)
  const wide = useMediaQuery('(min-width: 768px)')
  const navigate = useNavigate()
  // an address by the repo's path (a chip on a card of a project whose name was taken) lands on the project's own name
  const canonical = page.data?.name
  useEffect(() => {
    if (canonical && canonical !== name)
      void navigate({ to: '/projects/$name', params: { name: canonical }, replace: true })
  }, [canonical, name, navigate])

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

  const model = page.data
  const rows = plan.data?.rows ?? []
  const summary = planSummary(rows)
  const days = dayLabels(model.at)
  const shipped = sum(model.shipped.days)
  const swept = hygiene.data?.lastPass ?? null
  // the newest five passes, oldest first: the bars read left to right
  const passes = [...(hygiene.data?.passes ?? [])].reverse()
  const redProbes = hygiene.data?.probes.filter((p) => p.status === 'found' || p.status === 'failed').length ?? 0
  const sidePage = wide ? 'right' : 'bottom'
  const synced = model.syncedAt ? ageWords(Math.max(0, now - Date.parse(model.syncedAt))) : null
  const notes = [
    model.branch ? `Branch ${model.branch}` : null,
    synced ? `read ${synced}` : 'no project.yaml read yet',
    model.work ? 'a work project' : null,
  ].filter(Boolean)

  return (
    <Page fluid>
      <ProjectsSidebar name={name} />
      <PageHeader title={model.name} note={notes.join(', ')} />
      <nav aria-label="This project in other screens" className="-mt-4 mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link to="/flow" search={{ project: name }} className={LINK}>
          Flow
        </Link>
        <Link to="/chain" search={{ project: name }} className={LINK}>
          Chain
        </Link>
        <Link to="/artifacts" search={{ project: name }} className={LINK}>
          Artifacts
        </Link>
      </nav>
      {model.projectError ? (
        <p
          role="alert"
          className="mb-6 rounded-lg bg-[color-mix(in_srgb,var(--vx-bad-solid)_12%,transparent)] px-3 py-2 text-sm text-[color:var(--vx-bad-text)]"
        >
          The project.yaml on the default branch does not parse; the setup is the last valid one. {model.projectError}
        </p>
      ) : null}
      <div aria-label="Totals" role="group" className="mb-8 grid gap-3 lg:grid-cols-3">
        <StatCard
          icon={CheckCircleIcon}
          title="Shipped"
          subtitle="Against the 7 days before"
          value={shipped}
          delta={{ value: shipped - model.shipped.before, higherIsBetter: true }}
          sub={`${model.counts.working} working, ${model.counts.waiting} waiting, ${model.counts.queued} queued`}
          bars={model.shipped.days}
          barLabels={days}
          xLabels={[days[0] ?? '', days[3] ?? '', 'Today']}
          footer={[
            { label: 'Before', value: String(model.shipped.before) },
            { label: 'In Watch', value: String(model.production.watching.length) },
          ]}
          as={(props) => <Link to="/flow" search={{ project: name, state: 'closed' }} {...props} />}
        />
        <StatCard
          icon={ListChecksIcon}
          title="Plan"
          subtitle="Rows done of all rows"
          value={summary.percent === null ? null : `${summary.percent}%`}
          valueNote="This project has no plan rows"
          sub={summary.total === 0 ? undefined : `${summary.done} of ${summary.total} rows done`}
          bars={summary.total === 0 ? undefined : [summary.done, summary.open, summary.filable, summary.waiting]}
          barLabels={['Done', 'In flight', 'May file now', 'Waiting']}
          xLabels={['Done', 'In flight', 'Waiting']}
          chart={summary.total === 0 ? null : undefined}
          footer={[
            { label: 'In flight', value: plan.data ? String(summary.open) : null, note: 'The plan has not loaded' },
            {
              label: 'May file now',
              value: plan.data ? String(summary.filable) : null,
              note: 'The plan has not loaded',
            },
          ]}
          as={(props) => <Link to="/chain" search={{ project: name }} {...props} />}
        />
        <StatCard
          icon={ShieldCheckIcon}
          title="Hygiene"
          subtitle="Findings of the newest pass"
          value={hygiene.data && swept ? swept.findings : null}
          valueNote={hygiene.data ? 'No pass has swept this project yet' : 'The hygiene has not loaded'}
          sub={
            hygiene.data
              ? hygieneLine(
                  {
                    lastPassAt: swept?.at ?? null,
                    outcome: swept?.judgment.outcome ?? null,
                    findings: swept?.findings ?? 0,
                  },
                  now,
                  ageWords,
                )
              : undefined
          }
          bars={passes.length < 2 ? undefined : passes.map((pass) => pass.findings)}
          barLabels={passes.map((pass) => `${shortDate(pass.at)}: ${pass.findings} findings`)}
          xLabels={[shortDate(passes[0]?.at ?? ''), '', 'Last pass']}
          chart={passes.length < 2 ? null : undefined}
          footer={[
            { label: 'Probes red', value: hygiene.data ? String(redProbes) : null, note: 'The hygiene has not loaded' },
            {
              label: 'Documents stale',
              value: hygiene.data ? String(hygiene.data.documents.stale) : null,
              note: 'The hygiene has not loaded',
            },
          ]}
          href="#hygiene"
        />
      </div>
      <div className="grid gap-10">
        {flow.data ? <NowSection project={model} flow={flow.data} now={now} /> : null}
        <div className="grid gap-10 xl:grid-cols-2">
          <ShippedSection page={model} now={now} side={sidePage} />
          {plan.data ? (
            <PlanSection project={name} rows={rows} error={plan.data.error} warnings={plan.data.warnings} />
          ) : null}
        </div>
        <ProductionSection page={model} now={now} />
        <SetupSection setup={model.setup} source={model.source} />
        <div id="hygiene" className="min-w-0 scroll-mt-4">
          {hygiene.data ? <HygieneSection model={hygiene.data} now={now} /> : null}
        </div>
      </div>
    </Page>
  )
}
