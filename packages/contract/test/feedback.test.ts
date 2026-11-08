import { describe, expect, test } from 'bun:test'
import { FeedbackRequest, feedbackSource, feedbackTokenKey, DoorSource } from '../src/index.ts'

const valid = { app: 'weather', version: '1.2.0', route: '/forecast', title: 'The chart is empty' }

describe('FeedbackRequest', () => {
  test('the envelope parses, text defaults to empty, the source label and token key follow the app', () => {
    expect(FeedbackRequest.parse(valid)).toEqual({ ...valid, text: '' })
    expect(feedbackSource('weather')).toBe('feedback:weather')
    expect(DoorSource.safeParse(feedbackTokenKey('a'.repeat(23))).success).toBe(true)
  })

  test('it is strict: no repo, and an app name must fit the token key', () => {
    expect(FeedbackRequest.safeParse({ ...valid, repo: 'chat' }).success).toBe(false)
    expect(FeedbackRequest.safeParse({ ...valid, app: 'Weather' }).success).toBe(false)
    expect(FeedbackRequest.safeParse({ ...valid, app: 'a'.repeat(24) }).success).toBe(false)
  })

  test('version, route and title are required and bounded', () => {
    for (const field of ['version', 'route', 'title'] as const) {
      expect(FeedbackRequest.safeParse({ ...valid, [field]: '' }).success).toBe(false)
    }
    expect(FeedbackRequest.safeParse({ ...valid, version: 'v'.repeat(65) }).success).toBe(false)
    expect(FeedbackRequest.safeParse({ ...valid, route: 'r'.repeat(257) }).success).toBe(false)
  })
})
