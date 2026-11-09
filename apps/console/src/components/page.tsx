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

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full px-4 py-6 md:px-8 md:py-8 ${wide ? 'max-w-screen-2xl' : 'max-w-4xl'}`}>
      {children}
    </div>
  )
}
