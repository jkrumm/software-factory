import { treaty } from '@elysiajs/eden'
import type { App } from '@software-factory/server/app'

/** The Console's typed client: Eden over the server's app type, so a route change that breaks it fails `tsc`. */
export const consoleClient = (base: string) => treaty<App>(base)

/** The same client on an app instance, without a port: how the tests call it. */
export const inProcessClient = (app: App) => treaty<App>(app)
