import { createFileRoute } from '@tanstack/react-router'
import { EmptyState, Page, PageHeader } from '@/components/page'

export const Route = createFileRoute('/improve')({ component: Improve })

function Improve() {
  return (
    <Page>
      <PageHeader title="Improve" />
      <EmptyState title="Comes in the next step" />
    </Page>
  )
}
