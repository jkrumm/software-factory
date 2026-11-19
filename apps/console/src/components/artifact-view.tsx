import type { ArtifactDetail } from '@software-factory/contract'
import { ArrowLeftIcon, ChatCircleTextIcon, ListBulletsIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type PanelSize, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { Annotations, type Focus } from '@/components/artifact-comments'
import { CollapseButton, PANE, PANES_KEY, Rail, ReadingSizeControl } from '@/components/artifact-panes'
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { FORMAT_WORDS, GLOBAL_PATH, KIND_WORDS, pictureSources, type TocItem } from '@/lib/artifact'
import { lozengeStateOf } from '@/lib/issue-page'
import { useMediaQuery } from '@/lib/media'
import { setReadingSize, useReadingSize } from '@/lib/reading'
import { useNow } from '@/lib/now'
import { useScreen } from '@/lib/screen'
import { issueNumber } from '@/lib/policy'
import { useArtifact, useIssue } from '@/lib/queries'
import { highlightAnchors, imageComments, paintAnchorOf, type ReviewItem, reviewItems, useReview } from '@/lib/review'
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
          <Lozenge state={lozengeStateOf(issue)} />
          <ProjectChip name={issue.repoName} />
        </>
      ) : null}
    </div>
  )
}

/** Where the artifact hangs: its Issue, or the project of a standalone one, and the Issues it is linked to. */
function ArtifactCrumb({ artifact, peek }: { artifact: ArtifactDetail['artifact']; peek?: boolean }) {
  const linked = artifact.links.flatMap((ref) => {
    const number = issueNumber(ref)
    return number === null ? [] : [number]
  })
  return (
    <>
      {artifact.issueId ? (
        <IssueCrumb issueId={artifact.issueId} peek={peek} />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
          <span>No Issue owns this {KIND_WORDS[artifact.kind].toLowerCase()}</span>
          {artifact.repo ? <ProjectChip name={artifact.repo} /> : null}
        </div>
      )}
      {linked.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
          <span>{artifact.issueId ? 'Also concerns' : 'Concerns'}</span>
          {linked.map((number) => (
            <Link
              key={number}
              to="/issues/$id"
              params={{ id: String(number) }}
              data-peek={peek ? undefined : 'off'}
              className="rounded-md font-mono text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Issue {number}
            </Link>
          ))}
        </div>
      ) : null}
    </>
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
  const paned = wide && !peek
  const tocSide = useMediaQuery('(min-width: 1280px)') && paned
  const reading = useReadingSize()
  // the panes' sizes are kept per browser, in one layout for three panes and one for two
  const panelIds = tocSide ? ['document', 'contents', 'comments'] : ['document', 'comments']
  const layout = useDefaultLayout({
    id: `${PANES_KEY}-${panelIds.length}`,
    panelIds,
    storage: window.localStorage,
  })
  const contentsPane = usePanelRef()
  const commentsPane = usePanelRef()
  const [folded, setFolded] = useState({ contents: false, comments: false })
  const track = (pane: 'contents' | 'comments') => (size: PanelSize) => {
    const now = size.inPixels <= PANE.rail + 1
    setFolded((was) => (was[pane] === now ? was : { ...was, [pane]: now }))
  }
  const onJump = useCallback((to: string) => setJump((was) => ({ id: to, tick: (was?.tick ?? 0) + 1 })), [])
  // a click on a card brings its passage into view in the document
  const onFocus = useCallback(
    (item: ReviewItem) =>
      setFocus((was) => ({
        ...paintAnchorOf(item),
        id: item.id,
        tick: (was?.tick ?? 0) + 1,
        scroll: true,
        edit: false,
        ...(item.image ? { image: { spot: item.image.x !== null } } : {}),
      })),
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
  const quotes = useMemo(() => highlightAnchors(items), [items])
  const images = useMemo(() => imageComments(items), [items])
  // the sources of the artifact's pictures by hash: what a picture comment's card shows as its thumbnail
  const sources = useMemo(
    () => (detail ? pictureSources(detail.content, detail.artifact.format) : new Map<string, string>()),
    [detail],
  )
  // a click on a highlighted passage opens its comment: for the owner's own, in edit mode; the passage is already in view
  const onOpen = useCallback(
    (quote: string, id?: string) => {
      // a badge or a pin on a picture names its comment
      const picture = id ? items.find((i) => i.id === id && i.image && i.anchored) : undefined
      if (picture?.image) {
        const edit = picture.author === 'owner' && !picture.id.startsWith('pending:')
        setFocus((was) => ({
          ...paintAnchorOf(picture),
          id: picture.id,
          tick: (was?.tick ?? 0) + 1,
          scroll: false,
          edit,
          image: { spot: picture.image?.x !== null },
        }))
        return
      }
      const found = items.filter((i) => i.anchored && i.path !== GLOBAL_PATH && i.quote === quote)
      // the passage clicked names its comment; with equal quotes the owner's own comes first
      const item =
        found.find((i) => i.id === id) ??
        found.find((i) => i.author === 'owner' && !i.id.startsWith('pending:')) ??
        found[0]
      if (!item) return
      const edit = item.author === 'owner' && !item.id.startsWith('pending:')
      setFocus((was) => ({ ...paintAnchorOf(item), id: item.id, tick: (was?.tick ?? 0) + 1, scroll: false, edit }))
    },
    [items],
  )

  if (!detail) {
    if (screen === 'failed')
      return (
        <Shell>
          <EmptyState title="This artifact is not available">
            The factory could not load it. Reload the page, or open it again from Artifacts.
          </EmptyState>
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

  const docColumn = (
    <div className={cn('flex min-w-0 flex-col', !peek && 'lg:h-full lg:min-h-0')}>
      <header className={cn('flex flex-col gap-3 border-b px-4 pt-5 pb-4', !peek && 'md:px-8')}>
        <ArtifactCrumb artifact={artifact} peek={peek} />
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
                    onChange={(event) => pick({ compare: event.target.value ? Number(event.target.value) : undefined })}
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
            <ReadingSizeControl size={reading} onChange={setReadingSize} />
            {reviewable ? <VerdictControl key={detail.revision} detail={detail} now={now} /> : null}
            <ScreenLine detail={detail} />
          </div>
        </div>
      </header>

      {tocSide ? null : <TocBar items={toc} section={section} onJump={onJump} />}
      <div
        ref={docScroll}
        data-scroll-restoration-id={peek ? undefined : 'artifact-document'}
        className={cn('flex min-w-0 flex-col', !peek && 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto')}
      >
        <div
          className={
            comparing
              ? 'grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:min-h-0 lg:flex-1'
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
              images={images}
              focus={focus}
              onSelect={onSelect}
              onOpen={onOpen}
              onHeadings={setToc}
              onSection={setSection}
              jump={jump}
              cleared={cleared}
              stacked={peek}
              reading={reading}
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
                images={[]}
                focus={null}
                onSelect={onSelect}
                onOpen={onOpen}
                onHeadings={setToc}
                onSection={setSection}
                jump={null}
                cleared={0}
                reading={reading}
              />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )

  const commentsBody = (
    <Annotations
      detail={detail}
      items={items}
      review={review}
      focus={focus}
      now={now}
      sources={sources}
      onFocus={onFocus}
      scrollId={paned ? 'artifact-comments' : undefined}
      action={
        paned ? (
          <CollapseButton label="Fold Comments away" side="right" onClick={() => commentsPane.current?.collapse()} />
        ) : undefined
      }
    />
  )
  const commentCount = items.filter((i) => i.revision === detail.revision).length

  return (
    <div className={cn('w-full', paned ? 'h-full min-h-[40rem]' : 'grid grid-cols-[minmax(0,1fr)]')}>
      {paned ? (
        <ResizablePanelGroup
          id={`${PANES_KEY}-${panelIds.length}`}
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          <ResizablePanel id="document" minSize={PANE.document} className="min-w-0">
            {docColumn}
          </ResizablePanel>
          {tocSide ? (
            <>
              <ResizableHandle aria-label="Resize Contents" />
              <ResizablePanel
                id="contents"
                panelRef={contentsPane}
                defaultSize={PANE.contentsDefault}
                minSize={PANE.contentsMin}
                collapsible
                collapsedSize={PANE.rail}
                groupResizeBehavior="preserve-pixel-size"
                onResize={track('contents')}
                className="flex min-h-0 flex-col bg-muted/40"
              >
                {folded.contents ? (
                  <Rail
                    label="Contents"
                    icon={<ListBulletsIcon aria-hidden="true" className="size-4" />}
                    onExpand={() => contentsPane.current?.expand()}
                  />
                ) : (
                  <TocColumn
                    items={toc}
                    section={section}
                    onJump={onJump}
                    action={
                      <CollapseButton
                        label="Fold Contents away"
                        side="left"
                        onClick={() => contentsPane.current?.collapse()}
                      />
                    }
                  />
                )}
              </ResizablePanel>
            </>
          ) : null}
          <ResizableHandle aria-label="Resize Comments" />
          <ResizablePanel
            id="comments"
            panelRef={commentsPane}
            defaultSize={window.innerWidth >= 1800 ? PANE.commentsDefaultWide : PANE.commentsDefault}
            minSize={PANE.commentsMin}
            collapsible
            collapsedSize={PANE.rail}
            groupResizeBehavior="preserve-pixel-size"
            onResize={track('comments')}
            className="flex min-h-0 flex-col bg-card"
          >
            <aside aria-label="Comments" className="flex min-h-0 min-w-0 flex-1 flex-col">
              {folded.comments ? (
                <Rail
                  label="Comments"
                  count={commentCount}
                  icon={<ChatCircleTextIcon aria-hidden="true" className="size-4" />}
                  onExpand={() => commentsPane.current?.expand()}
                />
              ) : (
                commentsBody
              )}
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          {docColumn}
          <aside aria-label="Comments" className="flex min-w-0 flex-1 flex-col bg-card">
            {commentsBody}
          </aside>
        </>
      )}
      {selected && anchor ? (
        <Composer
          key={`${selected.quote}|${selected.path}|${selected.occurrence ?? ''}`}
          thumbnail={selected.image ? sources.get(selected.image.srcHash) : undefined}
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
