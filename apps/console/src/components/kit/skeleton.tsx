import { cn } from '@/lib/utils'

export interface SkeletonProps {
  /** The final height, so nothing jumps when the content arrives. A number is px. */
  height?: number | string
  width?: number | string
  /** A rounding class; default `rounded-lg`. */
  rounded?: string
  className?: string
}

/** A pulsing block at the final size. Still under reduced motion. */
export function Skeleton({ height = 16, width = '100%', rounded = 'rounded-lg', className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse bg-foreground/8 motion-reduce:animate-none', rounded, className)}
      style={{ height, width }}
    />
  )
}
