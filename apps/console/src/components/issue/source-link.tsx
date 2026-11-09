import { ArrowUpRightIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

/** An outside link, only when it is http(s). */
export function SourceLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (href === null || !/^https?:\/\//i.test(href)) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex w-fit items-center gap-1 text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
      <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
    </a>
  )
}

/** An in-app link in running text. */
export const LINK_CLASS =
  'w-fit text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50'
