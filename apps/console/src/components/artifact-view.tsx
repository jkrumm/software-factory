import { ArrowLeftIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Annotations, type Focus } from '@/components/artifact-comments'
import { Composer, ScreenLine, VerdictControl } from '@/components/artifact-panel'
import { TocBar, TocColumn } from '@/components/artifact-toc'
import { ArtifactContent, type Selected } from '@/components/artifact-content'
import { Ago } from '@/components/issue/ago'
import { ProjectChip } from '@/components/issue/project-chip'
import { Lozenge } from '@/components/kit/lozenge'
import { Skeleton } from '@/components/kit/skeleton'
import { EmptyState } from '@/components/page'
import { ArtifactSkeleton } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { FORMAT_WORDS, GLOBAL_PATH, KIND_WORDS, type TocItem } from '@/lib/artifact'
import { ISSUE_STATE_WORDS } from '@/lib/issue'
import { lozengeStateOf } from '@/lib/issue-page'
import { useMediaQuery } from '@/lib/media'
import { useNow } from '@/lib/now'
import { useScreen } from '@/lib/screen'
import { issueNumber } from '@/lib/policy'
import { useArtifact, useIssue } from '@/lib/queries'
import { highlightQuotes, type ReviewItem, reviewItems, useReview } from '@/lib/review'
import { cn } from '@/lib/utils'

/** The Issue this artifact belongs to: its number and title as a link back, with its state and project. */
function IssueCrumb({ issueId, peek }: { issueId: string; peek?: boolean }) {
  const number = issueNumber(issueId)
  const { data: issue } = useIssue(String(number ?? issueId))
  if (number === null) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--vx-text-sm)]">
      <Link
        to="/issues/$id"
        params={{ id: String(number) }}
        data-peek={peek ? undefined : 'off'}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0 font-mono text-xs">Issue {number}</span>
        {issue ? <span className="truncate">{issue.title}</span> : null}
      </Link>
      {issue ? (
        <>
          <Lozenge state={lozengeStateOf(issue)}>
            {issue.state === 'closed' ? undefined : ISSUE_STATE_WORDS[issue.state]}
          </Lozenge>
          <ProjectChip name={issue.repoName} />
        </>
      ) : null}
    </div>
  )
}

/**
 * The artifact: header, document and comments. The page lays them out in the viewport (the document and the comments
 * scroll apart); in a `peek` they stack and the panel scrolls as one. A comparison is the page's alone.
 */
export interface ArtifactViewProps {
  id: string
  revision: number | undefined
  compare?: number
  onPick: (next: { revision?: number; compare?: number }) => void
  peek?: boolean
}

/** Keyed on the artifact: the writes still on their way (and the selection, the open comment) belong to one artifact only. */
export function ArtifactView(props: ArtifactViewProps) {
  return <ArtifactViewOf key={props.id} {...props} />
}

function ArtifactViewOf({ id, revision, compare, onPick, peek }: ArtifactViewProps) {
  const primary = useArtifact(id, revision)
  const screen = useScreen(primary)
  const other = useArtifact(id, compare, compare !== undefined)
  const now = useNow(30_000)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [cleared, setCleared] = useState(0)
  const [focus, setFocus] = useState<Focus | null>(null)
  const docScroll = useRef<HTMLDivElement>(null)
  const wide = useMediaQuery('(min-width: 1024px)')
  const [anchor, setAnchor] = useState<Selected['rect'] | null>(null)
  // a new selection leaves the comment that was open
  const onSelect = useCallback((next: Selected) => {
    setSelected(next)
    setFocus(null)
  }, [])
  const review = useReview(id)
  const [toc, setToc] = useState<TocItem[]>([])
  const [section, setSection] = useState<string | null>(null)
  const [jump, setJump] = useState<{ id: string; tick: number } | null>(null)
  const tocSide = useMediaQuery('(min-width: 1800px)') && !peek
  const onJump = useCallback((to: string) => setJump((was) => ({ id: to, tick: (was?.tick ?? 0) + 1 })), [])
  // a click on a card brings its passage into view in the document
  const onFocus = useCallback(
    (item: ReviewItem) =>
      setFocus((was) => ({ id: item.id, quote: item.quote, tick: (was?.tick ?? 0) + 1, scroll: true, edit: false })),
    [],
  )

  // The comment box stays on its passage: a Markdown passage is followed through any scroll of the page or its column.
  useEffect(() => {
    if (!selected) {
      setAnchor(null)
      return
    }
    setAnchor(selected.rect)
    const { range } = selected
    if (!range) return
    const follow = () => {
      const { top, bottom, left } = range.getBoundingClientRect()
      setAnchor({ top, bottom, left })
    }
    window.addEventListener('scroll', follow, { passive: true, capture: true })
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, { capture: true })
      window.removeEventListener('resize', follow)
    }
  }, [selected])

  const detail = primary.data
  const items = useMemo(() => (detail ? reviewItems(detail, review.pending) : []), [detail, review.pending])
  const quotes = useMemo(() => highlightQuotes(items), [items])
  // a click on a highlighted passage opens its comment: for the owner's own, in edit mode; the passage is already in view
  const onOpen = useCallback(
    (quote: string) => {
      const found = items.filter((i) => i.anchored && i.path !== GLOBAL_PATH && i.quote === quote)
      const item = found.find((i) => i.author === 'owner' && !i.id.startsWith('pending:')) ?? found[0]
      if (!item) return
      const edit = item.author === 'owner' && !item.id.startsWith('pending:')
      setFocus((was) => ({ id: item.id, quote, tick: (was?.tick ?? 0) + 1, scroll: false, edit }))
    },
    [items],
  )

  if (!detail) {
    if (screen === 'failed')
      return (
        <Shell>
          <EmptyState title="This artifact is not available" />
        </Shell>
      )
    return peek ? <Skeleton height={320} className="m-4" /> : <ArtifactSkeleton />
  }

  const { artifact } = detail
  const reviewable = artifact.kind === 'concept' || artifact.kind === 'spec'
  const revisions = artifact.revisions.map((r) => r.n)
  const comparing = compare !== undefined && other.data
  const pick = (next: { revision?: number; compare?: number }) =>
    onPick({ revision: detail.revision, compare, ...next })
  const pad = artifact.format === 'html' ? '' : peek ? 'px-4 py-6' : 'px-4 py-6 md:px-8 md:py-8'
  const part = 'flex min-h-0 min-w-0 flex-col'

  return (
    <div
      className={cn(
        'grid w-full',
        !peek &&
          'lg:h-full lg:min-h-[40rem] lg:grid-cols-[minmax(0,1fr)_24rem] min-[1800px]:grid-cols-[minmax(0,1fr)_36rem]',
      )}
    >
      <div className={cn('flex min-w-0 flex-col', !peek && 'lg:min-h-0')}>
        <header className={cn('flex flex-col gap-3 border-b px-4 pt-5 pb-4', !peek && 'md:px-8')}>
          <IssueCrumb issueId={artifact.issueId} peek={peek} />
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-1 basis-80 flex-col gap-2">
              <h1
                className="font-heading text-xl font-semibold tracking-tight [text-wrap:balance]"
                title={artifact.title}
              >
                {artifact.title}
              </h1>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Badge variant="secondary">{KIND_WORDS[artifact.kind]}</Badge>
                <span>{FORMAT_WORDS[artifact.format]}</span>
                <span>· by {artifact.author === 'lead' ? 'the lead' : 'the factory'}</span>
                <span>
                  · <Ago iso={artifact.createdAt} now={now} className="font-mono" />
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <nav aria-label="Revisions" className="flex items-center gap-2 text-sm whitespace-nowrap">
                <span className="text-muted-foreground">Revision</span>
                {revisions.map((n) => (
                  <Link
                    key={n}
                    to="/artifacts/$id"
                    params={{ id }}
                    search={{ revision: n, compare }}
                    aria-current={n === detail.revision ? 'page' : undefined}
                    className="rounded-md px-2 py-0.5 tabular-nums hover:bg-accent aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
                  >
                    {n}
                  </Link>
                ))}
                {revisions.length > 1 && !peek ? (
                  <label className="ml-1 flex items-center gap-2">
                    Compare with
                    <select
                      aria-label="Compare with"
                      className="rounded-md bg-muted px-2 py-1"
                      value={compare ?? ''}
                      onChange={(event) =>
                        pick({ compare: event.target.value ? Number(event.target.value) : undefined })
                      }
                    >
                      <option value="">None</option>
                      {revisions
                        .filter((n) => n !== detail.revision)
                        .map((n) => (
                          <option key={n} value={n}>
                            Revision {n}
                          </option>
                        ))}
                    </select>
                  </label>
                ) : null}
              </nav>
              {reviewable ? <VerdictControl key={detail.revision} detail={detail} now={now} /> : null}
              <ScreenLine detail={detail} />
            </div>
          </div>
        </header>

        {tocSide ? null : <TocBar items={toc} section={section} onJump={onJump} />}
        <div
          ref={docScroll}
          className={cn('flex min-w-0 flex-col', !peek && 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto')}
        >
          <div
            className={
              comparing
                ? 'grid gap-4 md:grid-cols-2 lg:min-h-0 lg:flex-1'
                : cn('flex flex-col', !peek && 'lg:min-h-0 lg:flex-1')
            }
          >
            <section aria-label={`Revision ${detail.revision}`} className={cn(part, !peek && 'lg:flex-1', pad)}>
              {comparing ? <h2 className="mb-2 text-sm font-semibold">Revision {detail.revision}</h2> : null}
              <ArtifactContent
                key={detail.revision}
                format={artifact.format}
                content={detail.content}
                primary
                quotes={quotes}
                focus={focus}
                onSelect={onSelect}
                onOpen={onOpen}
                onHeadings={setToc}
                onSection={setSection}
                jump={jump}
                cleared={cleared}
                stacked={peek}
              />
            </section>
            {comparing ? (
              <section aria-label={`Revision ${other.data.revision}`} className={cn(part, 'lg:flex-1', pad)}>
                <h2 className="mb-2 text-sm font-semibold">Revision {other.data.revision}</h2>
                <ArtifactContent
                  key={other.data.revision}
                  format={other.data.artifact.format}
                  content={other.data.content}
                  primary={false}
                  quotes={[]}
                  focus={null}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onHeadings={setToc}
                  onSection={setSection}
                  jump={null}
                  cleared={0}
                />
              </section>
            ) : null}
          </div>
        </div>
      </div>
      <div
        className={cn(
          'flex min-w-0 flex-col',
          tocSide && 'grid grid-cols-3 grid-rows-[minmax(0,1fr)]',
          !peek && 'lg:min-h-0',
        )}
      >
        {tocSide ? (
          <div className="col-span-1 flex min-h-0 min-w-0 flex-col">
            <TocColumn items={toc} section={section} onJump={onJump} />
          </div>
        ) : null}
        <aside
          aria-label="Comments"
          className={cn('flex min-w-0 flex-1 flex-col bg-card', tocSide && 'col-span-2', !peek && 'lg:min-h-0')}
        >
          <Annotations detail={detail} items={items} review={review} focus={focus} now={now} onFocus={onFocus} />
        </aside>
      </div>
      {selected && anchor ? (
        <Composer
          key={`${selected.quote}|${selected.path}`}
          review={review}
          revision={detail.revision}
          selected={selected}
          anchor={anchor}
          docked={!wide}
          onDone={() => {
            setSelected(null)
            window.getSelection()?.removeAllRanges()
            setCleared((n) => n + 1)
          }}
        />
      ) : null}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="w-full px-4 py-6 md:px-8 md:py-8">{children}</div>
}
