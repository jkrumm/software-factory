import { Link } from '@tanstack/react-router'

/** The project as a chip that opens Flow filtered to it. */
export function ProjectChip({ name }: { name: string }) {
  return (
    <Link
      to="/flow"
      search={{ project: name }}
      className="inline-flex h-5 items-center rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {name}
    </Link>
  )
}
