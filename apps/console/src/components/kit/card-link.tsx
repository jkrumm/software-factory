import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** How a card renders its link: pass a router link here (`(p) => <Link to="/flow" {...p} />`); the default is an <a>. */
export type LinkRender = (props: { className: string; children: ReactNode }) => ReactElement

export interface CardLinkProps {
  /** A plain address. */
  href?: string
  /** A router link instead of the <a>. */
  as?: LinkRender
}

/** The classes that make a card's own element cover the whole card: a stretched link, so nothing nests inside an <a>. */
const STRETCHED = 'outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[""]'

/** The classes of a card that is a link: pointer, hover, and a focus ring on the stretched link. */
export const LINKED_CARD = 'cursor-pointer transition-colors hover:bg-accent'

/** Whether the pair makes a link at all. */
export const isLinked = ({ href, as }: CardLinkProps): boolean => href !== undefined || as !== undefined

/** Wraps the card's title; with neither `href` nor `as` it is the bare text and the card is not a link. */
export function CardLink({
  href,
  as,
  className,
  children,
}: CardLinkProps & { className?: string; children: ReactNode }) {
  const classes = cn(STRETCHED, className)
  if (as) return as({ className: classes, children })
  if (href !== undefined) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    )
  }
  return <span className={className}>{children}</span>
}
