import { ArtifactView } from '@/components/artifact-view'
import { IssueView } from '@/components/issue/view'
import type { Peek } from '@/lib/peek'

/** What the peek panel shows: the Issue's or the artifact's own view, in its narrow form. Its own chunk, fetched when the first peek opens. */
export default function PeekContent({
  peek,
  onChange,
}: {
  peek: Peek
  /** The tab or revision the owner picked inside the panel (the address keeps it, so a reload shows the same). */
  onChange: (next: Peek) => void
}) {
  if (peek.kind === 'issue') {
    return (
      <div className="px-4 pt-2 pb-8">
        <IssueView
          id={peek.id}
          tab={peek.tab}
          peek
          onTab={(tab) => onChange({ kind: 'issue', id: peek.id, ...(tab === 'overview' ? {} : { tab }) })}
        />
      </div>
    )
  }
  return (
    <ArtifactView
      id={peek.id}
      revision={peek.revision}
      peek
      onPick={({ revision }) => onChange({ kind: 'artifact', id: peek.id, ...(revision ? { revision } : {}) })}
    />
  )
}
