import type { Runner } from '../../src/runner.ts'

/** The half of `Runner` a test of starts does not use: nothing is ever typed. */
export const noType: Pick<Runner, 'type'> = { type: () => Promise.reject(new Error('no typing is expected')) }
