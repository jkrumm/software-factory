import { createAlerts } from './intake-alerts.ts'
import { createEntry } from './intake-entry.ts'
import { createHeld } from './intake-held.ts'
import { createLedger, type IntakeDeps } from './intake-kit.ts'
import { createPollers } from './intake-pollers.ts'
import { createQuarantine } from './intake-quarantine.ts'
import { createReceive } from './intake-receive.ts'
import { createRoutes } from './intake-routes.ts'
import { createSettle } from './intake-settle.ts'
import { createSignals } from './intake-signals.ts'

export { envelopeOfRequest } from './intake-envelope.ts'
export { DEFAULT_INTAKE_SETTINGS, type IntakeDeps, type IntakeError, type IntakeWrites } from './intake-kit.ts'

/**
 * Intake: what happens to a signal from the door to an Issue. The one export other code calls; each part below is a module
 * that takes its dependencies as one object, so a part can be read, and tested, without the others' bodies.
 */
export function createIntake(deps: IntakeDeps) {
  const ledger = createLedger(deps)
  const alerts = createAlerts({ deps, ledger })
  const signals = createSignals({ deps, ledger, alerts })
  const quarantine = createQuarantine({ deps, ledger })
  const receive = createReceive({ deps, alerts, signals, quarantine })
  const routes = createRoutes({ deps, alerts })
  const held = createHeld({ deps, routes })
  const entry = createEntry({ deps, receive })
  const settle = createSettle({ deps, alerts, routes, quarantine })
  const pollers = createPollers({ deps, receive })

  return {
    receive: receive.receive,
    file: entry.file,
    alert: entry.alert,
    feedback: entry.feedback,
    promote: held.promote,
    dismiss: held.dismiss,
    list: held.list,
    doorReport: entry.doorReport,
    routes: routes.routes,
    setRoute: routes.setRoute,
    removeRoute: routes.removeRoute,
    settle: settle.settle,
    healthLines: routes.healthLines,
    sink: pollers.sink,
  }
}

export type Intake = ReturnType<typeof createIntake>
