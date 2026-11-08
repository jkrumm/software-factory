import { FLOW_STATES, type FlowState } from '@software-factory/contract'
import { createFileRoute } from '@tanstack/react-router'
import { Page, PageHeader } from '@/components/page'
import { useFlow } from '@/lib/queries'

const STATE_LABEL: Record<FlowState, string> = {
  settling: 'Settling',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  watching: 'Watching',
}

export const Route = createFileRoute('/flow')({ component: Flow })

function Flow() {
  const { data, isPending } = useFlow()
  return (
    <Page>
      <PageHeader title="Flow" note={data ? undefined : isPending ? 'Loading' : 'No data yet'} />
      {data ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {FLOW_STATES.map((state) => (
            <li key={state} className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3">
              <span className="text-sm text-muted-foreground">{STATE_LABEL[state]}</span>
              <span className="font-heading text-2xl font-semibold tabular-nums">{data.states[state].count}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  )
}
