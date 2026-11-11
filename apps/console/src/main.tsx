import { RouterProvider } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { defaultShouldDehydrateQuery } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startLive } from '@/lib/live'
import { flowQuery, needsQuery, persister, queryClient, SNAPSHOT_MAX_AGE_MS } from '@/lib/queries'
import { initTheme } from '@/lib/theme'
import { reloadOnNavigation, startUpdates } from '@/lib/update'
import { router } from './router'
import './styles/index.css'

initTheme()
startUpdates()
startLive(queryClient)

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root')

// a new bundle waiting is loaded by the next navigation to another screen, never in the middle of reading one
router.subscribe('onBeforeLoad', ({ fromLocation, toLocation, pathChanged }) => {
  if (fromLocation && pathChanged) reloadOnNavigation(toLocation.href)
})

// the first screen's data is requested now, in parallel with the rest of the boot
void queryClient.prefetchQuery(needsQuery)
if (location.pathname === '/flow') void queryClient.prefetchQuery(flowQuery)

// the Chain's code and data wait until the page is idle, so a `g c` or a tap finds them loaded
const whenIdle = (run: () => void) =>
  'requestIdleCallback' in window ? window.requestIdleCallback(run, { timeout: 4000 }) : setTimeout(run, 1500)
whenIdle(() => void router.preloadRoute({ to: '/chain' }))

const SNAPSHOT_EXCLUDED = new Set(['artifact', 'issue', 'since'])

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: SNAPSHOT_MAX_AGE_MS,
        buster: __BUILD_ID__,
        // an artifact's text can be a megabyte and an Issue's detail carries its whole timeline, notes and signal text: both stay out of the snapshot, and so does the since band (reading it moves the server's visit marker)
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            defaultShouldDehydrateQuery(query) && !SNAPSHOT_EXCLUDED.has(String(query.queryKey[0])),
        },
      }}
      // the snapshot is a first paint, not an answer: restoring refetches everything, and hydrate keeps the newer dataUpdatedAt, so an answer already fetched is never replaced by it
      onSuccess={() => void queryClient.invalidateQueries(undefined, { cancelRefetch: false })}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
)
