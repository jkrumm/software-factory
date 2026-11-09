import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as z from 'zod'
import { Annotations, Composer, Verdict } from '@/components/artifact-panel'
import { ArtifactContent, type Selected } from '@/components/artifact-content'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { ageWords } from '@/lib/age'
import { FORMAT_WORDS, GLOBAL_PATH, KIND_WORDS, VERDICT_WORDS } from '@/lib/artifact'
import { useMediaQuery } from '@/lib/media'
import { useArtifact } from '@/lib/queries'
import { cn } from '@/lib/utils'

const Search = z.object({
  revision: z.number().int().min(1).optional().catch(undefined),
  compare: z.number().int().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/artifacts/$id')({
  validateSearch: Search,
  component: ArtifactPage,
})

const ago = (iso: string) => ageWords(Date.now() - Date.parse(iso))

function ArtifactPage() {
  const { id } = Route.useParams()
  const { revision, compare } = Route.useSearch()
  const navigate = Route.useNavigate()
  const primary = useArtifact(id, revision)
  const other = useArtifact(id, compare, compare !== undefined)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [cleared, setCleared] = useState(0)
  const [focus, setFocus] = useState<{ quote: string; tick: number } | null>(null)
  const docScroll = useRef<HTMLDivElement>(null)
  const wide = useMediaQuery('(min-width: 1024px)')
  const [anchorTop, setAnchorTop] = useState(0)
  const onSelect = useCallback((next: Selected) => setSelected(next), [])
  const onFocus = useCallback((quote: string) => setFocus((was) => ({ quote, tick: (was?.tick ?? 0) + 1 })), [])

  // The comment box is level with the passage; a Markdown passage can follow the document's own scroll.
  useEffect(() => {
    if (!selected) return
    setAnchorTop(selected.rect.top)
    const { range } = selected
    const scroller = docScroll.current
    if (!range || !scroller) return
    const follow = () => setAnchorTop(range.getBoundingClientRect().top)
    scroller.addEventListener('scroll', follow, { passive: true })
    return () => scroller.removeEventListener('scroll', follow)
  }, [selected])

  const detail = primary.data
  const quotes = useMemo(
    () => detail?.annotations.filter((a) => a.path !== GLOBAL_PATH).map((a) => a.quote) ?? [],
    [detail],
  )

  if (!detail) {
    if (primary.isError)
      return (
        <Shell>
          <EmptyState title="This artifact is not available" />
        </Shell>
      )
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Shell>
    )
  }

  const { artifact } = detail
  const reviewable = artifact.kind === 'concept' || artifact.kind === 'spec'
  const given = detail.verdicts.find((verdict) => verdict.revision === detail.revision)
  const revisions = artifact.revisions.map((r) => r.n)
  const comparing = compare !== undefined && other.data
  const pick = (next: { revision?: number; compare?: number }) =>
    void navigate({ search: { revision: detail.revision, compare, ...next } })
  const pad = artifact.format === 'html' ? '' : 'px-4 py-4 md:px-8 md:py-6'
  const part = 'flex min-h-0 min-w-0 flex-col'

  return (
    <div className="grid w-full lg:h-full lg:min-h-[40rem] lg:grid-cols-[minmax(0,1fr)_25rem]">
      <div className="flex min-w-0 flex-col lg:min-h-0">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pt-5 pb-3 md:px-8 lg:flex-nowrap">
          <h1 className="min-w-0 font-heading text-xl font-semibold tracking-tight lg:truncate" title={artifact.title}>
            {artifact.title}
          </h1>
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm whitespace-nowrap text-muted-foreground lg:flex-nowrap">
            <Badge variant="secondary">{KIND_WORDS[artifact.kind]}</Badge>
            <span className="max-2xl:hidden">{FORMAT_WORDS[artifact.format]}</span>
            <span className="max-2xl:hidden">· by {artifact.author === 'lead' ? 'the lead' : 'the factory'}</span>
            <span className="max-2xl:hidden">· {ago(artifact.createdAt)}</span>
            {reviewable ? (
              <Badge variant={given ? 'default' : 'outline'}>
                {given ? `${VERDICT_WORDS[given.verdict]} · ${ago(given.at)}` : 'Waiting for your verdict'}
              </Badge>
            ) : null}
          </div>
          <nav
            aria-label="Revisions"
            className="flex shrink-0 flex-wrap items-center gap-2 text-sm whitespace-nowrap lg:ml-auto lg:flex-nowrap"
          >
            <span className="text-muted-foreground">Revision</span>
            {revisions.map((n) => (
              <Link
                key={n}
                to="/artifacts/$id"
                params={{ id }}
                search={{ revision: n, compare }}
                aria-current={n === detail.revision ? 'page' : undefined}
                className="rounded-md px-2 py-0.5 tabular-nums hover:bg-accent aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
              >
                {n}
              </Link>
            ))}
            {revisions.length > 1 ? (
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
        </header>

        <div ref={docScroll} className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <div
            className={
              comparing ? 'grid gap-4 md:grid-cols-2 lg:min-h-0 lg:flex-1' : 'flex flex-col lg:min-h-0 lg:flex-1'
            }
          >
            <section aria-label={`Revision ${detail.revision}`} className={cn(part, 'lg:flex-1', pad)}>
              {comparing ? <h2 className="mb-2 text-sm font-semibold">Revision {detail.revision}</h2> : null}
              <ArtifactContent
                key={detail.revision}
                format={artifact.format}
                content={detail.content}
                primary
                quotes={quotes}
                focus={focus}
                onSelect={onSelect}
                cleared={cleared}
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
                  cleared={0}
                />
              </section>
            ) : null}
          </div>
        </div>
      </div>
      <div className="relative bg-card lg:min-h-0">
        <aside className="flex min-w-0 flex-col gap-5 p-4 lg:h-full lg:overflow-y-auto">
          {reviewable ? <Verdict key={detail.revision} detail={detail} /> : null}
          <Annotations detail={detail} onFocus={onFocus} />
        </aside>
        {selected ? (
          <Composer
            key={`${selected.quote}|${selected.path}`}
            id={id}
            revision={detail.revision}
            selected={selected}
            anchorTop={anchorTop}
            docked={!wide}
            onDone={() => {
              setSelected(null)
              window.getSelection()?.removeAllRanges()
              setCleared((n) => n + 1)
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="w-full px-4 py-6 md:px-8 md:py-8">{children}</div>
}
