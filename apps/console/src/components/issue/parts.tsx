import type { ReactNode } from 'react'

/** A section of the Issue page; the long ones are collapsible (`<details>`) and start closed unless `open`. */
export function Section({
  title,
  count,
  open = true,
  collapsible = false,
  children,
}: {
  title: string
  count?: number
  open?: boolean
  collapsible?: boolean
  children: ReactNode
}) {
  const heading = (
    <>
      {title}
      {count === undefined ? null : <span className="ml-2 tabular-nums text-muted-foreground">{count}</span>}
    </>
  )
  if (!collapsible)
    return (
      <section aria-label={title} className="grid gap-3">
        <h2 className="text-sm font-medium">{heading}</h2>
        {children}
      </section>
    )
  return (
    <section aria-label={title}>
      <details open={open} className="group grid gap-3">
        <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <h2 className="inline">{heading}</h2>
        </summary>
        <div className="mt-3 grid gap-3">{children}</div>
      </details>
    </section>
  )
}

export const Card = ({ children }: { children: ReactNode }) => (
  <div className="grid gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground">{children}</div>
)

export const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

/** A label with its figure, as a definition pair. */
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  )
}

export const Stats = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">{children}</dl>
)

export const Meta = ({ children }: { children: ReactNode }) => (
  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{children}</p>
)

/** An outside link, only when it is http(s). */
export function SourceLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (href === null || !/^https?:\/\//i.test(href)) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="w-fit text-primary underline underline-offset-4"
    >
      {children}
    </a>
  )
}
