import { Link } from '@tanstack/react-router'
import type { ProjectDigest } from '@software-factory/contract'
import { CaretRightIcon } from '@phosphor-icons/react'
import { useId, useState } from 'react'
import { Age } from '@/components/kit/issue-parts'
import { cn } from '@/lib/utils'

/** The counts in the order the owner reads a project: what is done, what runs, what is still to do, what is stuck. */
const COUNTS = [
  ['done7d', 'Done 7 d'],
  ['working', 'Working'],
  ['queued', 'Queued'],
  ['waiting', 'Waiting'],
] as const

const BULLETS = [
  ['shipped', 'Shipped'],
  ['next', 'Next'],
  ['risks', 'Risks'],
] as const

/** `issue_12` is Issue 12: the number the Issue's route takes. */
const numberOf = (id: string): string => id.replace(/^issue_/, '')

function Counts({ counts }: { counts: ProjectDigest['counts'] }) {
  return (
    <dl className="grid grid-cols-4 gap-2 px-2.5">
      {COUNTS.map(([key, label]) => (
        <div key={key} className="min-w-0">
          <dt className="truncate text-xs text-muted-foreground">{label}</dt>
          <dd className="text-[length:var(--vx-text-md)] font-semibold tabular-nums" data-count={key}>
            {counts[key]}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Bullets({ digest }: { digest: ProjectDigest }) {
  const groups = BULLETS.filter(([key]) => digest[key].length > 0)
  if (groups.length === 0)
    return <p className="px-2.5 py-2 text-sm text-muted-foreground">Nothing to say beyond the counts.</p>
  return (
    <div className="grid gap-3 px-2.5 py-2.5">
      {groups.map(([key, label]) => (
        <div key={key} role="group" aria-label={label}>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h4>
          <ul className="grid gap-1.5">
            {digest[key].map((bullet) => (
              <li
                key={`${bullet.text}:${bullet.ids.join(',')}`}
                className="text-[length:var(--vx-text-sm)] leading-snug wrap-anywhere"
              >
                {bullet.text}{' '}
                <span className="whitespace-nowrap">
                  {bullet.ids.map((id, i) => (
                    <span key={id}>
                      {i > 0 ? ' ' : null}
                      <Link
                        to="/issues/$id"
                        params={{ id: numberOf(id) }}
                        className="rounded-sm font-mono text-xs text-muted-foreground tabular-nums underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        #{numberOf(id)}
                      </Link>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * One project's digest as a card on the card surface step: the project (a link that filters the board to it) and the
 * digest's age, the headline alone on the inset step, the four counts, and a button that opens the shipped, next and risks
 * bullets, each citing its Issues by a link. Collapsed to the headline and the counts unless `open` says otherwise.
 */
function DigestCard({
  digest,
  now,
  open,
  onToggle,
}: {
  digest: ProjectDigest
  now: number
  open: boolean
  onToggle: () => void
}) {
  const panel = useId()
  const hasWords = digest.shipped.length + digest.next.length + digest.risks.length > 0
  return (
    <article
      data-testid="project-digest"
      data-project={digest.project}
      className="flex min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground"
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex items-center gap-2 px-2.5 pt-2 pb-1">
        <Link
          to="/flow"
          search={{ project: digest.project }}
          className="inline-flex h-5 min-w-0 items-center rounded-md bg-muted px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="truncate">{digest.project}</span>
        </Link>
        <Age since={digest.at} now={now} className="ml-auto shrink-0" />
      </header>
      <div className="rounded-lg bg-background px-2.5 py-2.5">
        <p
          className="line-clamp-3 text-[length:var(--vx-text-sm)] leading-snug font-medium wrap-anywhere"
          title={digest.headline}
        >
          {digest.headline}
        </p>
      </div>
      <Counts counts={digest.counts} />
      {hasWords ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            onClick={onToggle}
            className="mx-1 mt-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <CaretRightIcon
              weight="bold"
              aria-hidden="true"
              className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
            />
            {open ? 'Hide details' : 'Show shipped, next and risks'}
          </button>
          <div id={panel} hidden={!open}>
            <Bullets digest={digest} />
          </div>
        </>
      ) : (
        <div className="pb-1.5" />
      )}
    </article>
  )
}

/**
 * The strip above the Flow board: one card per project with a digest, newest digest first is not the order, the projects'
 * names are. `project` (the board's filter) shows that project alone and opens it. Nothing renders without a digest.
 */
export function DigestStrip({
  digests,
  now,
  project,
}: {
  digests: readonly ProjectDigest[]
  now: number
  project?: string
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const shown = project ? digests.filter((digest) => digest.project === project) : digests
  if (shown.length === 0) return null
  const toggle = (name: string) =>
    setOpened((was) => {
      const next = new Set(was)
      if (!next.delete(name)) next.add(name)
      return next
    })
  return (
    <div role="group" aria-label="Project digests" data-testid="digest-strip" className="mb-4">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-start gap-3">
        {shown.map((digest) => (
          <li key={digest.project} className="min-w-0">
            <DigestCard
              digest={digest}
              now={now}
              open={project ? !opened.has(digest.project) : opened.has(digest.project)}
              onToggle={() => toggle(digest.project)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
