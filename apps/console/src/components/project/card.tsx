import { Link } from '@tanstack/react-router'
import type { ProjectIndexRow } from '@software-factory/contract'
import { CardLink, LINKED_CARD } from '@/components/kit/card-link'
import { PASS_TONES } from '@/lib/project'
import { cn } from '@/lib/utils'
import { prefetchProject } from '@/lib/queries'
import { TONE_MARK } from '@/components/kit/tone'

function Figure({ label, value, title }: { label: string; value: number; title: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}

/** One project of the list: its name, what it has open and shipped, and how its last hygiene pass ended. The whole card opens the page. */
export function ProjectCard({
  project,
  headline,
  hygiene,
}: {
  project: ProjectIndexRow
  headline: string | null
  hygiene: string
}) {
  const { counts } = project
  const outcome = project.hygiene.outcome
  return (
    <article
      onPointerEnter={() => prefetchProject(project.name)}
      className={cn(
        'group relative flex h-full min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground',
        LINKED_CARD,
      )}
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex items-center gap-2 px-2.5 pt-2 pb-1">
        <h2 className="min-w-0 truncate text-[length:var(--vx-text-md)] font-semibold tracking-tight">
          <CardLink as={(props) => <Link to="/projects/$name" params={{ name: project.name }} {...props} />}>
            {project.name}
          </CardLink>
        </h2>
        {project.work ? (
          <span className="ml-auto inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-xs text-muted-foreground">
            Work
          </span>
        ) : null}
      </header>
      <div className="grid flex-1 content-start gap-3 rounded-lg bg-background px-2.5 py-2.5">
        <dl className="grid grid-cols-4 gap-2">
          <Figure label="Working" value={counts.working} title={`${project.watching} of them in Watch`} />
          <Figure label="Waiting" value={counts.waiting} title="Waiting for a named exit" />
          <Figure label="Queued" value={counts.queued} title="Queued or settling" />
          <Figure label="Shipped" value={counts.done7d} title="Closed done or healed in the last 7 days" />
        </dl>
        {headline ? (
          <p className="line-clamp-2 text-[length:var(--vx-text-sm)] text-muted-foreground">{headline}</p>
        ) : null}
      </div>
      <footer className="flex items-center gap-2 px-2.5 pt-0.5 pb-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{
            background: outcome
              ? TONE_MARK[project.hygiene.findings > 0 ? 'warn' : PASS_TONES[outcome]]
              : TONE_MARK.neutral,
          }}
        />
        <span className="min-w-0 truncate">{hygiene}</span>
      </footer>
    </article>
  )
}
