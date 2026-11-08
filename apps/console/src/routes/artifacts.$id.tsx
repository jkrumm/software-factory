import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import * as z from 'zod'
import { Annotations, Composer, Verdict } from '@/components/artifact-panel'
import { ArtifactContent, type Selected } from '@/components/artifact-content'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { ageWords } from '@/lib/age'
import { FORMAT_WORDS, GLOBAL_PATH, KIND_WORDS, VERDICT_WORDS } from '@/lib/artifact'
import { useArtifact } from '@/lib/queries'

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
  const onSelect = useCallback((next: Selected) => setSelected(next), [])
  const onFocus = useCallback((quote: string) => setFocus((was) => ({ quote, tick: (was?.tick ?? 0) + 1 })), [])

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

  return (
    <Shell>
      <header className="mb-6 flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{artifact.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{KIND_WORDS[artifact.kind]}</Badge>
          <span>{FORMAT_WORDS[artifact.format]}</span>
          <span>· by {artifact.author === 'lead' ? 'the lead' : 'the factory'}</span>
          <span>· {ago(artifact.createdAt)}</span>
          {reviewable ? (
            <Badge variant={given ? 'default' : 'outline'}>
              {given ? `${VERDICT_WORDS[given.verdict]} · ${ago(given.at)}` : 'Waiting for your verdict'}
            </Badge>
          ) : null}
        </div>
        <nav aria-label="Revisions" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Revision</span>
          {revisions.map((n) => (
            <Link
              key={n}
              to="/artifacts/$id"
              params={{ id }}
              search={{ revision: n, compare }}
              aria-current={n === detail.revision ? 'page' : undefined}
              className="rounded-md border px-2 py-0.5 aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
            >
              {n}
            </Link>
          ))}
          {revisions.length > 1 ? (
            <label className="ml-2 flex items-center gap-2">
              Compare with
              <select
                aria-label="Compare with"
                className="rounded-md border bg-background px-2 py-1"
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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className={comparing ? 'grid gap-4 md:grid-cols-2' : ''}>
          <section aria-label={`Revision ${detail.revision}`} className="min-w-0 rounded-xl border bg-card p-4">
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
            <section aria-label={`Revision ${other.data.revision}`} className="min-w-0 rounded-xl border bg-card p-4">
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
        <aside className="flex min-w-0 flex-col gap-6">
          {reviewable ? <Verdict key={detail.revision} detail={detail} /> : null}
          <Annotations detail={detail} onFocus={onFocus} />
        </aside>
      </div>

      {selected ? (
        <Composer
          key={`${selected.quote}|${selected.path}`}
          id={id}
          revision={detail.revision}
          selected={selected}
          onDone={() => {
            setSelected(null)
            window.getSelection()?.removeAllRanges()
            setCleared((n) => n + 1)
          }}
        />
      ) : null}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</div>
}
