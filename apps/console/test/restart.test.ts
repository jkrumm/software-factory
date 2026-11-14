import { describe, expect, test } from 'bun:test'
import { ApiError, failureNote, RESTART_NOTE } from '../src/lib/api.ts'
import { isNetworkError, restartPhase, RESTART_WINDOW_MS, retryDelay } from '../src/lib/restart.ts'

describe('restartPhase', () => {
  const at = 1_000_000
  test('nothing failed is ok', () => {
    expect(restartPhase({ failingSince: null, online: true, now: at })).toBe('ok')
  })
  test('a failure is a restart for the window, then offline', () => {
    expect(restartPhase({ failingSince: at, online: true, now: at + RESTART_WINDOW_MS - 1 })).toBe('restarting')
    expect(restartPhase({ failingSince: at, online: true, now: at + RESTART_WINDOW_MS })).toBe('offline')
  })
  test('an offline browser is offline', () => {
    expect(restartPhase({ failingSince: at, online: false, now: at })).toBe('offline')
    expect(restartPhase({ failingSince: null, online: false, now: at })).toBe('offline')
  })
})

test('only a rejected fetch is a network error, with a 1 s to 10 s backoff', () => {
  expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  expect(isNetworkError(new ApiError(502, '/v1/x'))).toBe(false)
  expect([0, 1, 2, 3, 4, 5].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000])
})

test('failureNote says the server restarts for a network error or no error while it does', () => {
  expect(failureNote(new TypeError('x'), true)).toBe(RESTART_NOTE)
  expect(failureNote(null, true)).toBe(RESTART_NOTE)
  expect(failureNote(new TypeError('x'))).toBe('The server cannot be reached')
  expect(failureNote(new ApiError(503, '/v1/x'), true)).toBe('The server answered 503')
})
