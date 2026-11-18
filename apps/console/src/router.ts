import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/** `scrollRestoration` keeps the position of the containers marked `data-scroll-restoration-id` (the Console scrolls inside `main`, not the window) across back and forward. */
export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
