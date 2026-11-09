import type { ReactNode } from 'react'

export { EmptyState } from '@/components/kit/empty-state'

/** `compact` puts the note on the title's line and tightens the space under it (a screen that fills the viewport). */
export function PageHeader({ title, note, compact }: { title: string; note?: string; compact?: boolean }) {
  return (
    <header className={compact ? 'mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5' : 'mb-6 flex flex-col gap-1'}>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </header>
  )
}

/** `fluid` fills the content area width with no cap and no height rule (a card grid); `wide` caps at the 2xl screen; `full` fills the content area and its height (a board), with no cap. */
export function Page({
  children,
  wide,
  full,
  fluid,
}: {
  children: ReactNode
  wide?: boolean
  full?: boolean
  fluid?: boolean
}) {
  const size = full
    ? 'flex flex-col lg:h-full lg:min-h-[44rem]'
    : fluid
      ? ''
      : `mx-auto ${wide ? 'max-w-screen-2xl' : 'max-w-4xl'}`
  return <div className={`w-full px-4 py-6 md:px-8 md:py-8 ${size}`}>{children}</div>
}
