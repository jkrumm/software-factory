import type { ReactNode } from 'react'

export { EmptyState } from '@/components/kit/empty-state'

export function PageHeader({ title, note }: { title: string; note?: string }) {
  return (
    <header className="mb-6 flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </header>
  )
}

/** `wide` caps at the 2xl screen; `full` fills the content area and its height (a board), with no cap. */
export function Page({ children, wide, full }: { children: ReactNode; wide?: boolean; full?: boolean }) {
  const size = full ? 'flex flex-col lg:h-full lg:min-h-[44rem]' : `mx-auto ${wide ? 'max-w-screen-2xl' : 'max-w-4xl'}`
  return <div className={`w-full px-4 py-6 md:px-8 md:py-8 ${size}`}>{children}</div>
}
