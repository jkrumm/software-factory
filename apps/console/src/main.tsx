import { RouterProvider } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { defaultShouldDehydrateQuery } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startLive } from '@/lib/live'
import { persister, queryClient, SNAPSHOT_MAX_AGE_MS } from '@/lib/queries'
import { initTheme } from '@/lib/theme'
import { router } from './router'
import './styles/index.css'

initTheme()
registerSW({ immediate: true })
startLive(queryClient)

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root')

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: SNAPSHOT_MAX_AGE_MS,
        buster: __BUILD_ID__,
        // an artifact's text can be a megabyte: it stays out of the snapshot
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) && query.queryKey[0] !== 'artifact',
        },
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
)
