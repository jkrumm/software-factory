import { createFileRoute } from '@tanstack/react-router'
import * as z from 'zod'
import { ArtifactView } from '@/components/artifact-view'
import { artifactQuery, PREFETCH_STALE_MS, prefetchDetail, queryClient } from '@/lib/queries'
import { issueNumber } from '@/lib/policy'

const Search = z.object({
  revision: z.number().int().min(1).optional().catch(undefined),
  compare: z.number().int().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/artifacts/$id')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ revision: search.revision }),
  /**
   * Starts the artifact's read without waiting for it, and the Issue's behind it (the header's link back names the Issue by
   * the artifact's `issueId`, so it cannot start earlier): a hover or focus on any link to the page runs this through the
   * router's intent preload, together with the page's chunk, and the page then opens on data.
   */
  loader: ({ params, deps }) => {
    void queryClient
      .fetchQuery({ ...artifactQuery(params.id, deps.revision), staleTime: PREFETCH_STALE_MS })
      .then((detail) => {
        const number = issueNumber(detail.artifact.issueId)
        if (number !== null) prefetchDetail('issue', String(number))
      })
      .catch(() => undefined)
  },
  component: ArtifactPage,
})

function ArtifactPage() {
  const { id } = Route.useParams()
  const { revision, compare } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <ArtifactView id={id} revision={revision} compare={compare} onPick={(search) => void navigate({ search })} />
}
