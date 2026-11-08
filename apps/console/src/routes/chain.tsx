import { createFileRoute } from '@tanstack/react-router'
import { EmptyState, Page, PageHeader } from '@/components/page'

export const Route = createFileRoute('/chain')({ component: Chain })

function Chain() {
  return (
    <Page>
      <PageHeader title="Chain" />
      <EmptyState title="Comes in the next step" />
    </Page>
  )
}
