import type { ReactNode } from 'react'

export function PageHeader({ title, note }: { title: string; note?: string }) {
  return (
    <header className="mb-6 flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </header>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed px-6 py-16 text-center">
      <p className="text-base font-medium">{title}</p>
      {children ? <p className="max-w-prose text-sm text-muted-foreground">{children}</p> : null}
    </div>
  )
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-8">{children}</div>
}
