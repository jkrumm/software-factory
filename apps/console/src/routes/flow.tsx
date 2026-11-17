import { createFileRoute, redirect } from '@tanstack/react-router'

/** Flow became the Overview at `/`: an old link or bookmark lands there with its filters (`project`, `origin`, `state`). */
export const Route = createFileRoute('/flow')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/', search: search as never, replace: true })
  },
})
