import { Link } from '@tanstack/react-router'
import type { ProjectIndexRow } from '@software-factory/contract'
import type { ReactNode } from 'react'
import { CardLink, LINKED_CARD } from '@/components/kit/card-link'
import { prefetchProject } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { HygieneCell, NowCell, PlanCell, ProductionCell, ShippedCell } from './cells'

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/**
 * One project on a phone: the table's row as a card, with the same cells (the state bar, the shipped line and count,
 * the production lamp, the plan meter, the hygiene figure). The whole card opens the project's page.
 */
export function ProjectCard({
  project,
  scale,
  labels,
  now,
  showGroup,
}: {
  project: ProjectIndexRow
  scale: number
  labels: string[]
  now: number
  /** the group beside the name: in the flat list, where no group heading says it */
  showGroup: boolean
}) {
  return (
    <article
      aria-label={project.name}
      onPointerEnter={() => prefetchProject(project.name)}
      className={cn('relative flex min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground', LINKED_CARD)}
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex items-center gap-2 px-2.5 pt-2 pb-1">
        <h2 className="min-w-0 truncate text-[length:var(--vx-text-md)] font-semibold tracking-tight">
          <CardLink as={(props) => <Link to="/projects/$name" params={{ name: project.name }} {...props} />}>
            {project.name}
          </CardLink>
        </h2>
        {showGroup ? <span className="shrink-0 text-xs text-muted-foreground">{project.group}</span> : null}
        <span className="ml-auto">
          <ProductionCell row={project} now={now} />
        </span>
      </header>
      <dl className="grid gap-1.5 rounded-lg bg-background px-2.5 py-2 text-[length:var(--vx-text-sm)]">
        <Line label="Now">
          <NowCell row={project} scale={scale} />
        </Line>
        <Line label="Shipped 7 d">
          <ShippedCell row={project} labels={labels} />
        </Line>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2">
            <dt className="text-xs text-muted-foreground">Plan</dt>
            <dd className="min-w-0">
              <PlanCell row={project} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">Hygiene</dt>
            <dd>
              <HygieneCell row={project} now={now} />
            </dd>
          </div>
        </div>
      </dl>
    </article>
  )
}
