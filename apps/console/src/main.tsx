import { RouterProvider } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { defaultShouldDehydrateQuery } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startLive } from '@/lib/live'
import { flowQuery, needsQuery, persister, queryClient, SNAPSHOT_MAX_AGE_MS } from '@/lib/queries'
import { initTheme } from '@/lib/theme'
import { router } from './router'
import './styles/index.css'

initTheme()
registerSW({ immediate: true })
startLive(queryClient)

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root')

// the first screen's data is requested now, in parallel with the rest of the boot
void queryClient.prefetchQuery(needsQuery)
if (location.pathname === '/flow') void queryClient.prefetchQuery(flowQuery)

const SNAPSHOT_EXCLUDED = new Set(['artifact', 'issue'])

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: SNAPSHOT_MAX_AGE_MS,
        buster: __BUILD_ID__,
        // an artifact's text can be a megabyte and an Issue's detail carries its whole timeline, notes and signal text: both stay out of the snapshot
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            defaultShouldDehydrateQuery(query) && !SNAPSHOT_EXCLUDED.has(String(query.queryKey[0])),
        },
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
)
