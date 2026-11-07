import type { Runner } from '../../src/runner.ts'

/** The half of `Runner` a test of starts does not use: nothing is ever typed, nothing closed. */
export const noType: Pick<Runner, 'type' | 'screen' | 'close'> = {
  type: () => Promise.reject(new Error('no typing is expected')),
  screen: () => Promise.reject(new Error('no screen is expected')),
  close: () => Promise.reject(new Error('no close is expected')),
}
